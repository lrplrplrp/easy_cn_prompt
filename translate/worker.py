"""本地 llama.cpp 推理子进程。

⚠️ 本机强约束（见开发文档 §7.5）：
  comfyui.sh 记录过 —— 若 `transformers` 先于 `llama_cpp` 被导入，
  llama.cpp 的堆会被破坏，崩在 std::regex 解析词表（malloc_printerr → abort）。
  ComfyUI 主进程必然先加载 transformers，所以本地推理**必须**放在子进程里，
  且本文件**第一行**就要 import llama_cpp（见 _worker_main）。

子进程常驻、按需启动、空闲超时退出，避免长期占用显存。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time

_IDLE_TIMEOUT = 600.0     # 空闲 10 分钟自动退出
_LOCK = threading.Lock()
_PROC: subprocess.Popen | None = None
_LAST_USED = 0.0
_LOADED_MODEL: str | None = None

_WORKER_ENV = "EASY_CN_PROMPT_WORKER"


def _worker_code() -> str:
    """子进程入口源码。llama_cpp 必须最先 import。"""
    return r'''
import json, sys

# ★ 必须第一行：llama_cpp 要早于 transformers ★
import llama_cpp

_llm = None
_loaded = None


def load(path, gpu):
    global _llm, _loaded
    key = path + ("|gpu" if gpu else "|cpu")
    if _loaded == key and _llm is not None:
        return
    # 卸载旧模型，避免显存堆积
    _llm = None
    _loaded = None
    _llm = llama_cpp.Llama(
        model_path=path,
        n_ctx=2048,
        n_gpu_layers=(-1 if gpu else 0),
        verbose=False,
        seed=0,
    )
    _loaded = key


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            print(json.dumps({"ok": False, "error": "bad json: %s" % e}), flush=True)
            continue

        if req.get("cmd") == "quit":
            print(json.dumps({"ok": True}), flush=True)
            return

        try:
            load(req["model"], bool(req.get("gpu", True)))
            out = _llm(
                req["prompt"],
                max_tokens=int(req.get("max_tokens", 128)),
                temperature=float(req.get("temperature", 0.7)),
                top_p=float(req.get("top_p", 0.6)),
                top_k=int(req.get("top_k", 20)),
                repeat_penalty=float(req.get("repeat_penalty", 1.05)),
                stop=["\n\n"],
            )
            text = (out.get("choices") or [{}])[0].get("text", "")
            print(json.dumps({"ok": True, "text": text}), flush=True)
        except Exception as e:
            print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}), flush=True)


if __name__ == "__main__":
    main()
'''


def _spawn() -> subprocess.Popen:
    """启动 worker 子进程。"""
    env = dict(os.environ)
    env[_WORKER_ENV] = "1"
    # Windows 下 Python 子进程的 stdout 默认用系统编码（cp936/GBK），
    # 中文会乱码甚至抛 UnicodeDecodeError。这里强制 UTF-8。
    env["PYTHONIOENCODING"] = "utf-8"
    proc = subprocess.Popen(
        [sys.executable, "-c", _worker_code()],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",     # ★ 与 PYTHONIOENCODING 一致
        errors="replace",     # 万一有非法字节，替换而不是崩溃
        bufsize=1,
        env=env,
    )
    return proc


def _ensure_proc() -> subprocess.Popen:
    global _PROC, _LAST_USED
    if _PROC is not None and _PROC.poll() is None:
        _LAST_USED = time.time()
        return _PROC
    _PROC = _spawn()
    _LAST_USED = time.time()
    return _PROC


def _is_alive() -> bool:
    return _PROC is not None and _PROC.poll() is None


def _shutdown_locked() -> None:
    """关闭子进程。**调用方必须已持有 _LOCK**。

    ⚠️ 必须与 shutdown() 分开：shutdown() 自己会拿 _LOCK，
    而 watchdog 已经在锁内 —— 直接调 shutdown() 会自己等自己，
    永久死锁，之后所有翻译请求全部卡住（只能重启 ComfyUI）。
    """
    global _PROC, _LOADED_MODEL
    p = _PROC
    _PROC = None
    _LOADED_MODEL = None
    if p is None:
        return
    try:
        if p.poll() is None:
            p.stdin.write(json.dumps({"cmd": "quit"}) + "\n")
            p.stdin.flush()
            p.wait(timeout=3)
    except Exception:  # noqa: BLE001
        pass
    try:
        if p.poll() is None:
            p.kill()
    except Exception:  # noqa: BLE001
        pass


def shutdown() -> None:
    """关闭子进程（线程安全的对外接口）。"""
    with _LOCK:
        _shutdown_locked()


def _watchdog() -> None:
    """空闲超时后自动退出，释放显存。"""
    while True:
        time.sleep(30)
        with _LOCK:
            if not _is_alive():
                continue
            if time.time() - _LAST_USED > _IDLE_TIMEOUT:
                # 已持有 _LOCK → 必须用无锁版本，否则自己等自己死锁
                _shutdown_locked()


_watchdog_started = False


# 单次请求的最长等待（秒）。含模型冷加载。
# GPU 初始化在本机可能死锁（Vulkan + ComfyUI 占用 dmabuf）。
# ⚠️ 这个值必须 **小于前端超时**（前端 60s），否则后端还没放弃、
#    前端已经断了 —— 用户看到的就是"翻译中…"卡住没反应。
#    45s = GPU 尝试(45) 失败后还有时间走 CPU 路径。
_REQ_TIMEOUT = 45.0
# GPU 模式卡死后，后续请求降级为 CPU（本次运行期间记住）
_gpu_disabled = False


def _readline_timeout(proc, timeout: float) -> str | None:
    """带超时地读一行；超时返回 None。

    ⚠️ **不能只用 selectors**（Windows 上 DefaultSelector 只支持 socket，
    对管道会抛 OSError WinError 10038 —— 这是 Windows 用户翻译必崩的原因）。

    做法：后台线程阻塞读一行 → 放进队列 → 主线程带超时取。
    这样 Linux / Windows 行为一致。
    """
    import queue
    import threading

    q: queue.Queue = queue.Queue(maxsize=1)

    def _reader() -> None:
        try:
            q.put(proc.stdout.readline())
        except Exception:  # noqa: BLE001
            q.put("")          # 读取失败 → 当作 EOF

    t = threading.Thread(target=_reader, daemon=True)
    t.start()
    try:
        return q.get(timeout=timeout)
    except queue.Empty:
        # 超时：读线程仍在阻塞，但不影响后续 kill（kill 会让 readline 抛错退出）
        return None


def _kill_worker_locked() -> None:
    """持锁状态下强杀 worker。"""
    global _PROC, _LOADED_MODEL
    p = _PROC
    _PROC = None
    _LOADED_MODEL = None
    if p is None:
        return
    try:
        if p.poll() is None:
            p.kill()
    except Exception:  # noqa: BLE001
        pass
    try:
        p.wait(timeout=3)
    except Exception:  # noqa: BLE001
        pass


def run_translate(model_path: str, prompt: str, max_tokens: int = 128) -> str:
    """在子进程里做一次翻译，返回原始文本。

    带超时保护：GPU 初始化死锁时，超时杀掉 worker 并降级 CPU 重试一次；
    仍失败则抛出明确错误，前端能立即收到失败提示而不是永远等待。
    """
    global _LAST_USED, _LOADED_MODEL, _watchdog_started, _gpu_disabled

    if not _watchdog_started:
        _watchdog_started = True
        threading.Thread(target=_watchdog, daemon=True).start()

    last_err: str | None = None

    # 最多尝试两轮：第一轮按当前 GPU 设置，若 GPU 卡死则降级 CPU 再试一次
    for attempt in (0, 1):
        gpu = (not _gpu_disabled) if attempt == 0 else False
        with _LOCK:
            proc = _ensure_proc()
            req = {"model": model_path, "prompt": prompt,
                   "max_tokens": max_tokens, "gpu": gpu}
            line = None
            timed_out = False
            try:
                proc.stdin.write(json.dumps(req) + "\n")
                proc.stdin.flush()
                line = _readline_timeout(proc, _REQ_TIMEOUT)
                if line is None:
                    timed_out = True
            except Exception as e:  # noqa: BLE001
                _kill_worker_locked()
                last_err = f"翻译子进程通信失败：{e}"
                continue   # 换 CPU 再试

            _LAST_USED = time.time()

            if timed_out:
                # 90 秒无响应 —— 多半是 GPU 初始化死锁
                _kill_worker_locked()
                if gpu:
                    _gpu_disabled = True     # 本次运行期间记住，之后直接走 CPU
                    last_err = (f"GPU 初始化超时（{_REQ_TIMEOUT:.0f}s），"
                                f"已自动降级为 CPU 模式重试")
                    continue
                last_err = f"翻译超时（{_REQ_TIMEOUT:.0f}s），worker 已重启"
                continue

            if not line:
                err = ""
                try:
                    err = (proc.stderr.read() or "")[-300:]
                except Exception:  # noqa: BLE001
                    pass
                _kill_worker_locked()
                last_err = f"翻译子进程意外退出：{err.strip()}"
                if gpu:
                    _gpu_disabled = True
                    continue
                continue

            try:
                res = json.loads(line)
            except Exception as e:  # noqa: BLE001
                _kill_worker_locked()
                last_err = f"翻译子进程返回非法结果：{line[:200]}"
                continue

            if not res.get("ok"):
                msg = res.get("error") or "未知错误"
                # 模型加载阶段失败（如显存不足）→ 降级 CPU 重试
                if gpu and ("cuda" in msg.lower() or "vulkan" in msg.lower()
                            or "memory" in msg.lower() or "device" in msg.lower()):
                    _kill_worker_locked()
                    _gpu_disabled = True
                    last_err = f"GPU 加载失败（{msg[:120]}），已降级 CPU 重试"
                    continue
                last_err = msg
                break

            _LOADED_MODEL = model_path
            return res.get("text", "")

    raise RuntimeError(last_err or "翻译失败（未知原因）")
