"""Engine-neutral conversation handoff packets for chat-session forks."""

from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MAX_FULL_HANDOFF_CHARS = 120_000
SMART_RECENT_MESSAGES = 8
_FILE_REF_RE = re.compile(r"(?<![\w/])(?:[\w.-]+/)*[\w.-]+\.[A-Za-z0-9_-]{1,12}")
_SAFE_SEGMENT_RE = re.compile(r"^[A-Za-z0-9_.:-]+$")


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


def append_handoff_log(
    workstep_dir: str | Path,
    session_id: str,
    messages: list[dict],
    *,
    source_engine: str,
    target_engine: str,
    mode: str,
) -> dict[str, Any]:
    """Append one engine handoff with only messages not logged previously."""
    if not _SAFE_SEGMENT_RE.fullmatch(session_id or ""):
        raise ValueError("Invalid handoff session id")
    visible = [
        item for item in messages
        if item.get("role") in {"user", "assistant"}
        and str(item.get("content") or "").strip()
        and not (
            item.get("role") == "assistant"
            and item.get("status") in {"running", "error", "stopped"}
        )
    ]
    cutoff_message_id = str(visible[-1].get("id") or "") if visible else ""
    package = compile_handoff(
        messages,
        mode,
        source_session_id=session_id,
        forked_from_message_id=cutoff_message_id or None,
    )
    handoff_id = str(uuid.uuid4())
    relative = Path("event_logs") / session_id / "handoffs.jsonl"
    path = (Path(workstep_dir).resolve() / relative).resolve()
    event_root = (Path(workstep_dir).resolve() / "event_logs").resolve()
    path.relative_to(event_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = _read_jsonl(path)
    logged_ids = {
        str(item.get("message_id") or "")
        for item in existing
        if item.get("type") == "message"
    }
    timestamp = datetime.now(timezone.utc).isoformat()
    summary = {
        key: package.get(key)
        for key in ("objective", "latest_request", "file_refs", "decisions", "constraints")
    }
    appended: list[dict[str, Any]] = [{
        "type": "handoff_start",
        "handoff_id": handoff_id,
        "timestamp": timestamp,
        "source_engine": source_engine,
        "target_engine": target_engine,
        "mode": mode,
        "summary": summary,
    }]
    for item in (visible if mode != "none" else []):
        message_id = str(item.get("id") or "")
        if not message_id or message_id in logged_ids:
            continue
        appended.append({
            "type": "message",
            "message_id": message_id,
            "role": str(item.get("role") or ""),
            "content": str(item.get("content") or ""),
            "created_at": item.get("created_at"),
        })
        logged_ids.add(message_id)
    appended.append({
        "type": "handoff_end",
        "handoff_id": handoff_id,
        "timestamp": timestamp,
        "cutoff_message_id": cutoff_message_id or None,
    })
    _replace_jsonl(path, [*existing, *appended])
    return {
        "version": 1,
        "handoff_id": handoff_id,
        "mode": mode,
        "source_engine": source_engine,
        "target_engine": target_engine,
        "cutoff_message_id": cutoff_message_id or None,
        "relative_path": relative.as_posix(),
        "consumed": False,
    }


def mark_handoff_consumed(workstep_dir: str | Path, metadata: dict[str, Any]) -> None:
    """Append a small lifecycle marker after the target engine accepts the handoff."""
    relative = str(metadata.get("relative_path") or "")
    if not relative:
        return
    root = Path(workstep_dir).resolve()
    path = (root / relative).resolve()
    path.relative_to((root / "event_logs").resolve())
    existing = _read_jsonl(path)
    existing.append({
        "type": "handoff_consumed",
        "handoff_id": metadata.get("handoff_id"),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })
    _replace_jsonl(path, existing)


def render_handoff_reference(
    metadata: dict[str, Any],
    workstep_dir: str | Path,
) -> str:
    """Render the bounded bootstrap that points the target engine at the log."""
    if metadata.get("mode") == "none":
        return ""
    root = Path(workstep_dir).resolve()
    handoff_path = (root / str(metadata.get("relative_path") or "")).resolve()
    handoff_path.relative_to((root / "event_logs").resolve())
    reading_instruction = (
        "先读取最新交接摘要和截止消息前最近的可见消息；需要追溯时再向前读取。"
        if metadata.get("mode") == "smart"
        else "读取截止消息之前的全部可见用户和助手消息。"
    )
    return (
        "<workstep_context_handoff>\n"
        "这是一次跨引擎会话交接。请先读取项目内的只读交接日志，再处理当前请求。\n"
        f"交接日志：{handoff_path}\n"
        f"交接 ID：{metadata.get('handoff_id')}\n"
        f"交接方式：{metadata.get('mode')}\n"
        f"截止消息：{metadata.get('cutoff_message_id') or '无'}\n"
        f"读取要求：{reading_instruction}\n"
        "只把日志中的可见用户/助手消息作为上下文，不要修改交接日志。\n"
        "</workstep_context_handoff>"
    )


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                records.append(item)
    return records


def _replace_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    payload = "".join(
        json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n"
        for item in records
    )
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
