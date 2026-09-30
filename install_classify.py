#!/usr/bin/env python3
"""安装「分类待确认」功能所需的依赖。

为什么单独装：
  setfit / sentence-transformers 会拖入 pandas、pyarrow、datasets 等，
  并会把 fsspec 降级。而 fsspec 被 huggingface_hub 和 torch 依赖 ——
  直接装进 ComfyUI 环境有**破坏现有环境**的风险
  （尤其 torch 若是 ROCm/CUDA 定制版）。

因此用 pip --target 装到插件自己的目录，靠 sys.path 隔离加载。

用法（Windows / Linux / macOS 通用）：
    python install_classify.py

    # 指定 ComfyUI 的 Python（自动探测失败时）
    python install_classify.py "C:\\ComfyUI\\venv\\Scripts\\python.exe"
"""
from __future__ import annotations

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "data", "cls_pkgs")

# 依赖清单来自实测（缺一个都会 ImportError）
PKGS = [
    "setfit",
    "sentence-transformers",
    "pandas",
    "pyarrow",
    "datasets",
    "accelerate",
    "dill",
    "multiprocess",
    "xxhash",
    "evaluate",
]


def find_python() -> str:
    """找一个可用的 Python（优先 ComfyUI 的 venv）。"""
    if len(sys.argv) > 1 and sys.argv[1].strip():
        return sys.argv[1].strip()

    # 常见位置（Windows / Linux / macOS）
    home = os.path.expanduser("~")
    cands = [
        # 当前解释器所在的 venv（若已在 ComfyUI 环境里跑这个脚本）
        sys.executable,
        os.path.join(HERE, "..", "venv", "Scripts", "python.exe"),
        os.path.join(HERE, "..", "venv", "bin", "python"),
        os.path.join(HERE, "..", "..", "venv", "Scripts", "python.exe"),
        os.path.join(HERE, "..", "..", "venv", "bin", "python"),
        os.path.join(home, "ComfyUI", "venv", "Scripts", "python.exe"),
        os.path.join(home, "ComfyUI", "venv", "bin", "python"),
        os.path.join(home, "Applications", "ComfyUI", "ComfyUI", "venv", "bin", "python"),
        sys.executable,   # 兜底：当前解释器
    ]
    for c in cands:
        p = os.path.normpath(c)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return sys.executable


def main() -> int:
    py = find_python()
    print(f"使用 Python: {py}")
    print(f"安装到:     {TARGET}")
    print()

    os.makedirs(TARGET, exist_ok=True)

    for pkg in PKGS:
        print(f"── 安装 {pkg}")
        # --no-deps 是关键：逐个装，避免 pip 连带重装 torch 等
        r = subprocess.run(
            [py, "-m", "pip", "install", "--quiet",
             "--target", TARGET, "--no-deps", pkg],
            check=False,
        )
        if r.returncode != 0:
            print(f"   ⚠️ {pkg} 安装失败（退出码 {r.returncode}）")
            print("   若提示找不到 pip，请改用 ComfyUI 自带的 python 执行本脚本。")

    print()
    print("✅ 完成。依赖已装在插件内，ComfyUI 环境未被改动。")
    print("   接着重启 ComfyUI，「分类待确认」按钮即可用。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
