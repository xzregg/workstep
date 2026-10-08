"""Shared display of all captured prompt content for opted-in assistants."""

from collections import OrderedDict
from threading import Lock

import json
import re


def _content_block(value, language: str = "text") -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)
    # User content cannot end the enclosing fence or inject viewer headings.
    fence = "`" * max(3, max((len(run) for run in re.findall(r"`+", text)), default=0) + 1)
    return f"{fence}{language}\n{text}\n{fence}"


def format_prompt_input(data: dict) -> str:
    parts = []
    if data.get("attempt", 1) > 1:
        parts.append(f"## 重试 {data['attempt']}")
    instruction = data.get("system_prompt")
    if instruction:
        role = "developer" if data.get("instruction_transport") == "developer" else "system"
        title = "### 系统注入提示词" if data.get("instruction_transport") == "injection" else f"### 独立指令（{role}）"
        parts.extend([title, _content_block(instruction)])
    title = "### 正文（user，包含指令正文降级）" if data.get("system_prompt_in_body") else "### 正文（user）"
    parts.extend([title, _content_block(data.get("prompt") or "")])
    history = data.get("message_history")
    if history:
        parts.append("### 显式传入的历史消息")
        for index, message in enumerate(history, 1):
            if isinstance(message, dict):
                role = message.get("role")
                if role not in {"system", "developer", "user", "assistant", "tool"}:
                    role = "unknown"
                parts.extend([f"#### 历史 {index}（{role}）", _content_block(message if set(message) - {"role", "content"} else message.get("content", ""))])
            else:
                parts.extend([f"#### 历史 {index}", _content_block(message)])
    if data.get("images"):
        parts.extend(["### 图片输入", _content_block(data["images"], "json")])
    return "\n\n".join(parts)


# Live inspection cache; persistent assistants also save the formatted snapshot in their existing prompt field.

_prompt_views: OrderedDict[tuple[str, str], str] = OrderedDict()
_prompt_views_lock = Lock()


def append_prompt_view(namespace, message_id: str, data: dict) -> str:
    snapshot = format_prompt_input(data)
    key = (str(namespace), message_id)
    with _prompt_views_lock:
        previous = _prompt_views.pop(key, "")
        value = f"{previous}\n\n{snapshot}" if previous else snapshot
        _prompt_views[key] = value
        while len(_prompt_views) > 256:
            _prompt_views.popitem(last=False)
        return value


def get_prompt_view(namespace, message_id: str) -> str | None:
    with _prompt_views_lock:
        return _prompt_views.get((str(namespace), message_id))
