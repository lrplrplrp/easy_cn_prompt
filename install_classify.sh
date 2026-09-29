#!/usr/bin/env bash
# 安装「分类待确认」功能所需的依赖。
#
# 为什么单独装：
#   setfit / sentence-transformers 会拖入 pandas、pyarrow、datasets 等，
#   并会把 fsspec 从 2026.7.0 降级到 2026.6.0。
#   而 fsspec 被 huggingface_hub 和 torch 依赖 ——
#   直接装进 ComfyUI 环境有**破坏现有环境**的风险
#   （尤其 torch 若是 ROCm/CUDA 定制版）。
#
# 因此用 pip --target 装到插件自己的目录，靠 sys.path 隔离加载。
#
# 用法：
#   bash install_classify.sh /path/to/ComfyUI/venv/bin/python
#   或直接        bash install_classify.sh          # 自动探测 ComfyUI venv
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HERE/easy_cn_prompt/data/cls_pkgs"

# ── 找 Python ──
PY="${1:-}"
if [ -z "$PY" ]; then
  for c in \
    "$HOME/Applications/ComfyUI/ComfyUI/venv/bin/python" \
    "$HERE/../../venv/bin/python" \
    "$(command -v python3 || true)"; do
    if [ -n "$c" ] && [ -x "$c" ]; then PY="$c"; break; fi
  done
fi
if [ -z "$PY" ] || [ ! -x "$PY" ]; then
  echo "找不到 Python。用法：bash install_classify.sh /path/to/venv/bin/python" >&2
  exit 1
fi

echo "使用 Python: $PY"
echo "安装到:     $TARGET"
echo

mkdir -p "$TARGET"

# --no-deps 是关键：逐个装，避免 pip 连带重装 torch 等
# 依赖清单来自实测（缺一个都会 ImportError）
PKGS=(
  setfit
  sentence-transformers
  pandas
  pyarrow
  datasets
  accelerate
  dill
  multiprocess
  xxhash
  evaluate
)

for p in "${PKGS[@]}"; do
  echo "── 安装 $p"
  "$PY" -m pip install --quiet --target "$TARGET" --no-deps "$p"
done

echo
echo "✅ 完成。依赖已装在插件内，ComfyUI 环境未被改动。"
echo "   接着准备模型：见 README「自动分类待确认」章节。"
