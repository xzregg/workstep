"""Validation shared by project and workflow quick buttons."""

import re
import uuid
from pathlib import PurePosixPath


ACTION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}\Z")


def valid_script_path(value: str) -> bool:
    path = PurePosixPath(value)
    return bool(value) and not path.is_absolute() and all(
        part not in {"", ".", ".."} for part in value.split("/")
    ) and "\\" not in value and "\x00" not in value


def normalize_quick_buttons(buttons: list, *, max_buttons: int = 20) -> list[dict]:
    if not isinstance(buttons, list) or len(buttons) > max_buttons:
        raise ValueError(f"最多配置 {max_buttons} 个快捷按钮")
    cleaned: list[dict] = []
    seen: set[str] = set()
    for item in buttons:
        if not isinstance(item, dict):
            raise ValueError("快捷按钮格式无效")
        label = str(item.get("label") or "").strip()
        prompt = str(item.get("prompt") or "").strip()
        content = str(item.get("content") or "").strip()
        kind = str(item.get("kind") or "prompt").strip()
        if not label:
            raise ValueError("快捷按钮标签不能为空")
        if len(label) > 1000:
            raise ValueError("快捷按钮标签不能超过 1000 字")
        if len(prompt) > 400:
            raise ValueError("快捷按钮提示词不能超过 400 字")
        if len(content) > 4000:
            raise ValueError("展示内容不能超过 4000 字")
        if kind not in {"prompt", "display", "action"}:
            raise ValueError("快捷按钮类型无效")
        button_id = str(item.get("id") or uuid.uuid4())
        if button_id in seen:
            raise ValueError("快捷按钮 id 重复")
        seen.add(button_id)
        result = {
            "id": button_id,
            "label": label,
            "prompt": prompt if kind == "prompt" else "",
            "kind": kind,
            "immediate_send": item.get("immediate_send") is True if kind == "prompt" else False,
        }
        if kind == "display":
            result["content"] = content
        if kind == "action":
            action_id = str(item.get("action_id") or "").strip()
            script_path = str(item.get("script_path") or "").strip()
            cwd_mode = str(item.get("cwd_mode") or "task")
            confirmation_input_prompt = str(item.get("confirmation_input_prompt") or "").strip()
            if not ACTION_ID.fullmatch(action_id):
                raise ValueError("Action ID 无效")
            if not valid_script_path(script_path):
                raise ValueError("脚本路径无效")
            if cwd_mode not in {"project", "task", "worktrees"}:
                raise ValueError("执行目录无效")
            if len(confirmation_input_prompt) > 200:
                raise ValueError("确认输入提示不能超过 200 字")
            require_confirmation = item.get("require_confirmation") is not False
            result.update({
                "action_id": action_id,
                "script_path": script_path,
                "cwd_mode": cwd_mode,
                "require_confirmation": require_confirmation,
                "confirmation_input_prompt": confirmation_input_prompt,
            })
        cleaned.append(result)
    return cleaned
