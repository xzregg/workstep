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
        raise ValueError(f"Maximum {max_buttons} quick buttons can be configured")
    cleaned: list[dict] = []
    seen: set[str] = set()
    for item in buttons:
        if not isinstance(item, dict):
            raise ValueError("Invalid shortcut button format")
        label = str(item.get("label") or "").strip()
        prompt = str(item.get("prompt") or "").strip()
        content = str(item.get("content") or "").strip()
        kind = str(item.get("kind") or "prompt").strip()
        if not label:
            raise ValueError("The shortcut button label cannot be empty")
        if len(label) > 1000:
            raise ValueError("The shortcut button label cannot exceed 1000 characters")
        if len(prompt) > 400:
            raise ValueError("The prompt for the shortcut button cannot exceed 400 characters")
        if len(content) > 4000:
            raise ValueError("Displayed content cannot exceed 4000 characters")
        if kind not in {"prompt", "display", "action"}:
            raise ValueError("Invalid shortcut button type")
        button_id = str(item.get("id") or uuid.uuid4())
        if button_id in seen:
            raise ValueError("Duplicate shortcut button id")
        seen.add(button_id)
        result = {
            "id": button_id,
            "enabled": item.get("enabled") is not False,
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
                raise ValueError("Invalid Action ID")
            if not valid_script_path(script_path):
                raise ValueError("Invalid script path")
            if cwd_mode not in {"project", "task", "worktrees"}:
                raise ValueError("Invalid execution directory")
            if len(confirmation_input_prompt) > 200:
                raise ValueError("Confirm that the input prompt cannot exceed 200 characters")
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
