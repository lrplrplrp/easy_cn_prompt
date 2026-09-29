"""翻译适配器。

设计要点（见开发文档 §7）：
  - 本地 llama.cpp 必须在**子进程**里跑。
    本机 comfyui.sh 记录过：transformers 若先于 llama_cpp 导入会破坏 llama.cpp 堆，
    崩在 std::regex 解析词表。ComfyUI 主进程必然先加载 transformers，
    因此本地推理一律隔离到子进程。
  - 适配器可插拔，后续加"免费接口"只需新增一个子类。
"""

from __future__ import annotations

import os
import re
import threading

_PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


def models_dir() -> str:
    """翻译模型的存放目录：ComfyUI/models/easy_cn_prompt/"""
    try:
        import folder_paths  # type: ignore

        base = folder_paths.models_dir
    except Exception:  # noqa: BLE001
        base = os.path.join(_PLUGIN_ROOT, "data", "models")
    d = os.path.join(base, "easy_cn_prompt")
    os.makedirs(d, exist_ok=True)
    return d


def list_models() -> list[dict]:
    """扫描模型目录下的 gguf 文件。"""
    d = models_dir()
    out: list[dict] = []
    try:
        for fn in sorted(os.listdir(d)):
            if not fn.lower().endswith(".gguf"):
                continue
            p = os.path.join(d, fn)
            try:
                size = os.path.getsize(p)
            except OSError:
                size = 0
            out.append({
                "name": fn,
                "path": p,
                "size": size,
                "size_text": f"{size / 1024 / 1024:.0f} MB" if size else "未知",
            })
    except OSError:
        pass
    return out


def resolve_model(name: str) -> str | None:
    """把下拉里选的名字解析成绝对路径。"""
    if not name:
        return None
    # 直接给的就是路径
    if os.path.isabs(name) and os.path.isfile(name):
        return name
    d = models_dir()
    p = os.path.join(d, name)
    if os.path.isfile(p):
        return p
    return None


# --------------------------------------------------------------------------
# 提示词模板（Hy-MT2 官方）
# --------------------------------------------------------------------------

# 中 ⇄ 外：官方模板
ZH_TMPL = "将以下文本翻译为{target}，注意只需要输出翻译后的结果，不要额外解释：\n\n{text}"
# 外 ⇄ 外
EN_TMPL = ("Translate the following text into {target}. Note that you should only output "
           "the translated result without any additional explanation:\n\n{text}")

# Hy-MT2 要求使用**语言全名**，不能写 en/zh
LANG_ZH = "中文"
LANG_EN = "英语"


def has_cjk(s: str) -> bool:
    """是否包含中日韩汉字（用来判定翻译方向）。"""
    return any("\u4e00" <= ch <= "\u9fff" for ch in (s or ""))


def is_mixed(text: str) -> bool:
    """文本是否**中英混合**（既有中文字符又有拉丁字母）。"""
    if not text:
        return False
    zh = has_cjk(text)
    en = bool(re.search(r"[A-Za-z]", text))
    return zh and en


def strip_weight(text: str) -> str:
    """去掉 A1111 权重语法，返回纯词面。

       "双马尾 (1.2)" → "双马尾"
       "(masterpiece:1.3)" → "masterpiece"
       "long hair" → "long hair"
    """
    if not text:
        return text
    t = text.strip()
    # 整体包着的 (xxx:权重)
    m = re.fullmatch(r"\((.*?):\s*[\d.]+\s*\)", t)
    if m:
        return m.group(1).strip()
    # 尾部独立权重 "xxx (1.2)" / "xxx(1.2)"
    t = re.sub(r"\s*\(\s*[\d.]+\s*\)\s*$", "", t)
    return t.strip()


def detect_direction(text: str) -> bool:
    """判定翻译方向：True = 译成英文，False = 译成中文。

    规则（见开发文档 §11N / §12V）：
      - **中英混合** → 译成中文（取英文部分，恩为英文才是实际标签）
      - 纯中文     → 译成英文（最终输出必须是英文标签）
      - 纯英文     → 译成中文（只用来生成中文显示名，输出仍是原英文）
    """
    if is_mixed(text):
        return False        # ★ 混合 → 优先英译中
    return has_cjk(text)


def build_prompt(text: str, to_english: bool) -> str:
    """按官方模板拼提示词。target 必须用语言全名。"""
    if to_english:
        return ZH_TMPL.format(target=LANG_EN, text=text)
    return EN_TMPL.format(target="Chinese", text=text)


_WS_RE = re.compile(r"\s+")


def clean_output(s: str) -> str:
    """清理模型输出。

    Hy-MT2 有时会带上引号、前缀说明或多余换行，这里统一收敛成一行标签样式。
    """
    if not s:
        return ""
    t = s.strip()
    # 去掉常见的前后缀包装
    t = re.sub(r"^(译文|翻译|translation|output)\s*[:：]\s*", "", t, flags=re.I)
    t = t.strip().strip('"').strip("'").strip("“”").strip()
    # 多行只取第一行非空内容
    lines = [ln.strip() for ln in t.splitlines() if ln.strip()]
    if lines:
        t = lines[0]
    # 折叠空白
    t = _WS_RE.sub(" ", t).strip()
    # 去掉结尾标点（标签不需要句号）
    t = t.rstrip("。.！!？?，,;；")
    t = t.strip()
    # ★ 统一转小写 ★
    # 主流绘画模型（Danbooru 系 / Pony / Illustrious / Flux）的标签都是小写，
    # 模型常会返回 "Cyber Fox" 这种首字母大写，直接进提示词会降低命中率。
    # 统一小写后交给各模型的输出规则再处理（下划线/前缀等）。
    t = t.lower()
    return t


# --------------------------------------------------------------------------
# 适配器基类
# --------------------------------------------------------------------------

class Translator:
    name = "base"

    def available(self) -> bool:
        raise NotImplementedError

    def translate(self, text: str, to_english: bool = True) -> str:
        raise NotImplementedError


class LlamaGgufTranslator(Translator):
    """本地 llama.cpp（子进程隔离）。"""

    name = "llama_gguf"

    def __init__(self, model_name: str):
        self.model_name = model_name
        self.model_path = resolve_model(model_name)

    def available(self) -> bool:
        return bool(self.model_path)

    def translate(self, text: str, to_english: bool = True) -> str:
        from . import worker

        if not self.model_path:
            raise RuntimeError(f"找不到模型：{self.model_name}")
        prompt = build_prompt(text, to_english)
        raw = worker.run_translate(self.model_path, prompt)
        return clean_output(raw)


class OpenAICompatTranslator(Translator):
    """OpenAI 兼容 HTTP 端点（vLLM / SGLang / ollama 等）。"""

    name = "openai_compat"

    def __init__(self, base_url: str = "", api_key: str = "", model: str = "", timeout: int = 60):
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = api_key or ""
        self.model = model or "Hy-MT2-1.8B"
        self.timeout = timeout

    def available(self) -> bool:
        return bool(self.base_url)

    def translate(self, text: str, to_english: bool = True) -> str:
        import json as _json
        import urllib.request

        prompt = build_prompt(text, to_english)
        body = _json.dumps({
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.7,
            "top_p": 0.6,
            "max_tokens": 256,
        }).encode("utf-8")

        req = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=body,
            headers={
                "Content-Type": "application/json",
                **({"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}),
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            data = _json.loads(resp.read().decode("utf-8"))
        raw = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
        return clean_output(raw)


class FreeApiTranslator(Translator):
    """免费接口占位（决议①：留开口，暂不实现）。"""

    name = "free_api"

    def available(self) -> bool:
        return False

    def translate(self, text: str, to_english: bool = True) -> str:
        raise NotImplementedError("免费接口适配器待接入")


# --------------------------------------------------------------------------
# 翻译缓存
# --------------------------------------------------------------------------

_cache: dict[tuple, str] = {}
_cache_lock = threading.Lock()
_CACHE_MAX = 2000


def translate_cached(translator: Translator, text: str, to_english: bool = True) -> str:
    key = (translator.name, getattr(translator, "model_name", ""), text, to_english)
    with _cache_lock:
        if key in _cache:
            return _cache[key]

    result = translator.translate(text, to_english)

    with _cache_lock:
        if len(_cache) >= _CACHE_MAX:
            # 简单的容量控制：清掉最早的一半
            for k in list(_cache.keys())[: _CACHE_MAX // 2]:
                _cache.pop(k, None)
        _cache[key] = result
    return result
