"""Easy CN Prompt — ComfyUI 中文提示词节点。"""

from __future__ import annotations

import os

from .nodes.cn_prompt_node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .routes.api import ROUTES

# 让 ComfyUI 加载 web/ 下的前端扩展
WEB_DIRECTORY = "./web"

# 版本号与后端 API 保持一致（启动日志会打印，便于确认装的是哪一版）
__version__ = "0.22.4"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]


def _register_routes() -> None:
    try:
        from server import PromptServer  # type: ignore

        PromptServer.instance.app.add_routes(ROUTES)
        print("[EasyCNPrompt] 已注册 API 路由 /easy_cn_prompt/*")
    except Exception as exc:  # noqa: BLE001
        print(f"[EasyCNPrompt] 路由注册失败: {exc}")


def _report_optional_features() -> None:
    """启动时提示可选功能的可用状态。

    分类依赖（200MB）和翻译模型（1.1GB）都不随仓库分发，
    用户很容易"装好了但功能是灰的却不知道为什么"。
    在启动日志里说清楚，省得到处找原因。
    """
    try:
        from .translate import classify

        ok, why = classify.available()
        if ok:
            print("[EasyCNPrompt] 自动分类：就绪")
        else:
            print(f"[EasyCNPrompt] 自动分类：不可用 —— {why}")
    except Exception as exc:  # noqa: BLE001
        print(f"[EasyCNPrompt] 自动分类：检查失败（{exc}）")

    try:
        from .translate import base as tb

        models = tb.list_models()
        if models:
            print(f"[EasyCNPrompt] 本地翻译：就绪（{len(models)} 个模型）")
        else:
            print(f"[EasyCNPrompt] 本地翻译：未找到模型 —— 请把 gguf 放到 "
                  f"{tb.models_dir()}")
    except Exception as exc:  # noqa: BLE001
        print(f"[EasyCNPrompt] 本地翻译：检查失败（{exc}）")


_register_routes()

print(f"[EasyCNPrompt] v{__version__} 已加载，web 目录: {os.path.abspath(WEB_DIRECTORY)}")
_report_optional_features()
