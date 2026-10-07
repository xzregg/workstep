"""Shared AG-UI translation for assistant history and detailed timelines."""

from engines.codex_visualize import CODEX_ENGINE_IDS, convert_event_visualize_markers
from agent_assistants.event_truncation import truncate_large_tool_payloads
from engines.core.agui import AGUIContext, to_agui_events

_AGUI_EVENT_TYPES = {
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CHUNK",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "REASONING_MESSAGE_CHUNK",
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_CHUNK",
    "TOOL_CALL_RESULT",
    "RUN_STARTED",
    "RUN_FINISHED",
    "RUN_ERROR",
    "CUSTOM",
}


def _detail_agui_events(
    events: list[dict],
    *,
    project_id: str,
    session_id: str,
    message_id: str,
    engine: str | None = None,
    channel: str = "session_chat",
) -> list[dict]:
    translated: list[dict] = []
    for index, event in enumerate(events, start=1):
        if engine in CODEX_ENGINE_IDS:
            event = convert_event_visualize_markers(event)
        # 出口截断：JSONL 里单条工具输出可达数十 MB，全量下发会冻结浏览器
        # （前端展示上限本就远小于此）。日志保留全量，此处只影响响应。
        event = truncate_large_tool_payloads(event)
        event_type = str(event.get("type") or "")
        sequence = int(event.get("seq") or event.get("sequence") or index)
        if event_type in _AGUI_EVENT_TYPES:
            item = dict(event)
            item.setdefault("sequence", sequence)
            item.setdefault("messageId", message_id)
            translated.append(item)
            continue
        timestamp = event.get("timestamp")
        ctx = AGUIContext(
            project_id=project_id,
            message_id=message_id,
            channel=channel,
            session_id=session_id,
            event_sequence=sequence,
            created_at=timestamp if isinstance(timestamp, str) else None,
            timestamp=timestamp if isinstance(timestamp, (int, float)) else None,
        )
        translated.extend(to_agui_events(event, ctx))
    return translated

