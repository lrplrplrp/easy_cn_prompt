#!/usr/bin/env bash
# 安装「分类待确认」功能所需的依赖。
#
# 为什么单独装：
#   setfit / sentence-transformers 会拖入 pandas、pyarrow、datasets 等，
#   并会把 fsspec 降级。而 fsspec 被 huggingface_hub 和 torch 依赖 ——
#   直接装进 ComfyUI 环境有**破坏现有环境**的风险
#   （尤其 torch 若是 ROCm/CUDA 定制版）。
#
# 因此用 pip --target 装到插件自己的目录，靠 sys.path 隔离加载。
#
# 用法：
#   bash install_classify.sh                          # 自动探测 Python
#   bash install_classify.sh /path/to/venv/bin/python # 手动指定
#
# Windows 用户：请在 **ComfyUI 的 Python** 下执行等价命令
#   （见 README「安装 → 自动分类」的 Windows 说明）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HERE/data/cls_pkgs"

# ── 找 Python ──
# 优先用显式传入的，其次探测常见的 ComfyUI venv 位置，最后退回 PATH 里的 python3
PY="${1:-}"
if [ -z "$PY" ]; then
  for c in \
    "$HERE/../venv/bin/python" \
    "$HERE/../../venv/bin/python" \
    "$HOME/ComfyUI/venv/bin/python" \
    "$HOME/Applications/ComfyUI/ComfyUI/venv/bin/python" \
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
echo "   接着重启 ComfyUI，「分类待确认」按钮即可用。"
