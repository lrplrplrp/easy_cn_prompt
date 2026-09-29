"""Easy CN Prompt — ComfyUI 中文提示词节点。"""

from __future__ import annotations

import os

from .nodes.cn_prompt_node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .routes.api import ROUTES

# 让 ComfyUI 加载 web/ 下的前端扩展
WEB_DIRECTORY = "./web"

# 版本号与后端 API 保持一致（启动日志会打印，便于确认装的是哪一版）
__version__ = "0.18.0"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]


def _register_routes() -> None:
    try:
        from server import PromptServer  # type: ignore

        PromptServer.instance.app.add_routes(ROUTES)
        print("[EasyCNPrompt] 已注册 API 路由 /easy_cn_prompt/*")
    except Exception as exc:  # noqa: BLE001
        print(f"[EasyCNPrompt] 路由注册失败: {exc}")


_register_routes()

print(f"[EasyCNPrompt] v{__version__} 已加载，web 目录: {os.path.abspath(WEB_DIRECTORY)}")
