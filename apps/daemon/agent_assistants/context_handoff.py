"""Engine-neutral conversation handoff packets for chat-session forks."""

from __future__ import annotations

import json
import re
from typing import Any


MAX_FULL_HANDOFF_CHARS = 120_000
SMART_RECENT_MESSAGES = 8
_FILE_REF_RE = re.compile(r"(?<![\w/])(?:[\w.-]+/)*[\w.-]+\.[A-Za-z0-9_-]{1,12}")


def _visible_messages(messages: list[dict]) -> list[dict[str, str]]:
    return [
        {
            "role": str(item.get("role") or ""),
            "content": str(item.get("content") or ""),
        }
        for item in messages
        if item.get("role") in {"user", "assistant"}
        and str(item.get("content") or "").strip()
        and not (
            item.get("role") == "assistant"
            and item.get("status") in {"running", "error", "stopped"}
        )
    ]


def compile_handoff(
    messages: list[dict],
    mode: str,
    *,
    source_session_id: str,
    forked_from_message_id: str | None = None,
) -> dict[str, Any]:
    """Compile visible chat content into a deterministic transfer packet."""
    if mode not in {"smart", "full", "none"}:
        raise ValueError(f"Unsupported fork context mode: {mode}")
    visible = _visible_messages(messages)
    if mode == "none":
        selected: list[dict[str, str]] = []
    elif mode == "full":
        if sum(len(item["content"]) for item in visible) > MAX_FULL_HANDOFF_CHARS:
            raise ValueError("完整聊天记录过长，请改用智能交接")
        selected = visible
    else:
        selected = visible[-SMART_RECENT_MESSAGES:]

    first_user = next(
        (item["content"] for item in visible if item["role"] == "user"),
        "",
    )
    latest_user = next(
        (item["content"] for item in reversed(visible) if item["role"] == "user"),
        "",
    )
    file_refs = sorted({
        match.group(0)
        for item in visible
        for match in _FILE_REF_RE.finditer(item["content"])
    })
    decisions = [
        item["content"]
        for item in visible
        if item["role"] == "assistant"
        and any(marker in item["content"] for marker in ("决定", "采用", "使用", "已确认"))
    ][-6:]
    constraints = [
        item["content"]
        for item in visible
        if any(marker in item["content"] for marker in ("必须", "不能", "不要", "约束", "仅限"))
    ][-6:]
    return {
        "version": 1,
        "mode": mode,
        "source_session_id": source_session_id,
        "forked_from_message_id": forked_from_message_id,
        "message_count": len(selected),
        "objective": first_user if mode == "smart" else "",
        "latest_request": latest_user if mode == "smart" else "",
        "file_refs": file_refs if mode == "smart" else [],
        "decisions": decisions if mode == "smart" else [],
        "constraints": constraints if mode == "smart" else [],
        "messages": selected,
        "consumed": False,
    }


def render_handoff(package: dict[str, Any]) -> str:
    """Render a transfer packet as one clearly delimited bootstrap block."""
    if package.get("mode") == "none":
        return ""
    payload = {
        key: value
        for key, value in package.items()
        if key != "consumed"
    }
    return (
        "<workstep_context_handoff>\n"
        "以下内容来自另一个会话，只作为交接上下文。请核对项目文件，不要把摘要当作未经验证的事实。\n"
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n"
        "</workstep_context_handoff>"
    )
