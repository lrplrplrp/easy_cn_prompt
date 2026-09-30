"""本地分类器（SetFit）—— 进程内直接调用。

⚠️ 依赖隔离方案：
  setfit / sentence-transformers 及其依赖装在 `data/cls_pkgs/` 这个
  **独立目录**里（用 pip --target），加载时插到 sys.path 最前面。
  这样既不动 ComfyUI 的 venv（torch 是 ROCm 定制版，绝不能覆盖），
  也能正常 import。

  为什么不用子进程：依赖已隔离，进程内调用更简单、无通信开销、
  也不会有子进程超时/僵尸问题。

模型目录：data/models/setfit_cls/（随插件走，不依赖外部路径）
"""

from __future__ import annotations

import os
import threading

_PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
_PKG_DIR = os.path.join(_PLUGIN_ROOT, "data", "cls_pkgs")
_MODEL_DIR = os.path.join(_PLUGIN_ROOT, "data", "models", "setfit_cls")

_LOCK = threading.Lock()
_MODEL = None
_LABELS: list[int] = []
_LOAD_ERROR: str | None = None


def pkg_dir() -> str:
    return _PKG_DIR


def model_dir() -> str:
    return _MODEL_DIR


def available() -> tuple[bool, str]:
    """检查分类功能是否可用。

    返回 (是否可用, 说明)。说明是**给用户看的**，必须包含"怎么修"，
    不能只丢一个路径 —— 用户不知道那是什么意思。
    """
    if not os.path.isdir(_MODEL_DIR):
        return False, (
            "缺少分类模型。请确认插件完整下载（data/models/setfit_cls/ 目录），"
            "然后重启 ComfyUI。"
        )
    if not os.path.isdir(_PKG_DIR):
        # 依赖体积大（约 200MB），不随仓库分发，需要用户自己装
        return False, (
            "尚未安装分类依赖（首次使用需要，约 200MB）。"
            "在插件目录执行：python install_classify.py"
            "（脚本会自动找到 ComfyUI 的 Python），然后重启 ComfyUI。"
        )
    if _LOAD_ERROR:
        return False, f"分类依赖加载失败：{_LOAD_ERROR}"
    return True, "就绪"


def _ensure_path() -> None:
    """把隔离目录插到 sys.path 最前（只插一次）。"""
    if _PKG_DIR not in os.sys.path:
        os.sys.path.insert(0, _PKG_DIR)


def _load():
    """懒加载模型（首次调用时加载，之后复用）。"""
    global _MODEL, _LABELS, _LOAD_ERROR

    if _MODEL is not None:
        return _MODEL
    if _LOAD_ERROR:
        raise RuntimeError(_LOAD_ERROR)

    _ensure_path()
    # 离线：模型已在本地，避免联网检查（也避免国内网络问题）
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

    try:
        from setfit import SetFitModel

        _MODEL = SetFitModel.from_pretrained(_MODEL_DIR)
        _LABELS = [int(x) for x in _MODEL.labels]
    except Exception as e:  # noqa: BLE001
        _LOAD_ERROR = f"分类模型加载失败：{type(e).__name__}: {e}"
        raise RuntimeError(_LOAD_ERROR) from e
    return _MODEL


def classify(texts: list[str]) -> dict:
    """对一批文本分类。

    输入形如 ["长发 长发", "水枪 水枪"]（中文名 + 英文标签）。
    返回 {"ok": True, "results": [{"text","cat","conf"}]}
    """
    if not texts:
        return {"ok": True, "results": []}

    ok, why = available()
    if not ok:
        return {"ok": False, "error": why}

    try:
        import numpy as np

        with _LOCK:
            model = _load()
            probs = np.asarray(model.predict_proba([str(t) for t in texts]))
            labels = list(_LABELS)

        out = []
        for i, t in enumerate(texts):
            row = probs[i]
            j = int(row.argmax())
            out.append({
                "text": str(t),
                "cat": labels[j] if j < len(labels) else 0,
                "conf": round(float(row[j]), 4),
            })
        return {"ok": True, "results": out}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def warmup() -> dict:
    """预热（可选）：提前把模型载入内存。"""
    ok, why = available()
    if not ok:
        return {"ok": False, "error": why}
    try:
        _load()
        return {"ok": True, "labels": list(_LABELS)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
