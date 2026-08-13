"""AG-UI 翻译层 — ACP 对齐内部事件 → AG-UI 标准事件。

内部事件（``InternalEvent``，含编排类合成事件）在此统一翻译为 AG-UI 标准事件，
WebSocket 实时推送与历史回放共用。AG-UI 事件携带 passthrough 扩展字段
（``task_id`` / ``step_key`` / ``message_id`` / ``channel`` / ``session_id`` /
``engine`` / ``model`` / ``sequence`` / ``timestamp`` / ``created_at``），供前端
按 channel 分流与消息累加。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Mapping

# status 事件中代表"运行生命周期"的状态集合，映射为 RUN_*；其余状态
# （reviewing / awaiting_review / retrying / rework …）走 CUSTOM workstep.status。
_RUN_STARTED_STATUSES = {"initializing", "running", "pending"}
_RUN_FINISHED_STATUSES = {"done", "passed", "ready", "succeeded", "completed"}
_RUN_ERROR_STATUSES = {"failed", "cancelled", "error"}

_CUSTOM_NAMES: dict[str, str] = {
    "interaction_request": "workstep.interaction_request",
    "interaction_response": "workstep.interaction_response",
    "plan": "workstep.plan",
    "plan_update": "workstep.plan_update",
    "plan_removed": "workstep.plan_removed",
    "usage_update": "workstep.usage",
    "session_info_update": "workstep.session_info_update",
    "available_commands_update": "workstep.available_commands_update",
    "config_option_update": "workstep.config_option_update",
    "current_mode_update": "workstep.current_mode_update",
    "mcp_message": "workstep.mcp_message",
    "elicitation_completed": "workstep.elicitation_completed",
    "subagent": "workstep.subagent",
    "compacted": "workstep.compacted",
    "engine_state": "workstep.engine_state",
    "session_started": "workstep.session_started",
    "error": "workstep.error",
    "acp_raw": "workstep.acp_raw",
    "action_proposal": "workstep.action_proposal",
    "flow_proposals": "workstep.flow_proposals",
    "flow_proposals_rejected": "workstep.flow_proposals_rejected",
    "task_draft": "workstep.task_draft",
    "step_retrying": "workstep.step_retrying",
    "step_rework": "workstep.step_rework",
    "run_recovered": "workstep.run_recovered",
    "review_context": "workstep.review_context",
    "a2ui": "a2ui.surface",
}

# 订阅过滤用的"状态类"事件：任务列表只需要这些事件即可保持运行状态
# 刷新（对应前端 isStatusEvent / runRecovered 的判定集合）。
_STATUS_EVENT_TYPES = {"RUN_STARTED", "RUN_FINISHED", "RUN_ERROR"}
_STATUS_CUSTOM_NAMES = {
    "workstep.status",
    "workstep.step_retrying",
    "workstep.step_rework",
    "workstep.run_recovered",
}


def is_status_event(event: Mapping[str, Any]) -> bool:
    """判断 AG-UI 事件是否属于"状态类"（低流量，列表页订阅用）。"""
    if event.get("type") in _STATUS_EVENT_TYPES:
        return True
    return (
        event.get("type") == "CUSTOM"
        and event.get("name") in _STATUS_CUSTOM_NAMES
    )


@dataclass
class AGUIContext:
    """AG-UI passthrough 扩展字段；缺省字段从事件 dict 兜底读取。"""

    task_id: str | None = None
    step_key: str | None = None
    message_id: str | None = None
    channel: str | None = None
    session_id: str | None = None
    engine: str | None = None
    model: str | None = None
    event_sequence: int | None = None
    timestamp: int | None = None
    created_at: str | None = None

    @classmethod
    def from_event(cls, event: Mapping[str, Any], **overrides) -> "AGUIContext":
        """从发布事件 dict 提取上下文，允许显式覆盖（用于翻译层调用点）。"""
        return cls(
            task_id=overrides.get("task_id", event.get("task_id")),
            step_key=overrides.get("step_key", event.get("step_key")),
            message_id=overrides.get("message_id", event.get("message_id")),
            channel=overrides.get("channel", event.get("channel")),
            session_id=overrides.get("session_id", event.get("session_id")),
            engine=overrides.get("engine", event.get("engine")),
            model=overrides.get("model", event.get("model")),
            event_sequence=overrides.get(
                "event_sequence",
                event.get("event_sequence", event.get("sequence")),
            ),
            timestamp=overrides.get(
                "timestamp",
                event.get("timestamp"),
            ),
            created_at=overrides.get("created_at", event.get("created_at")),
        )


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(value)


def _extract_content_text(data: Mapping[str, Any]) -> str:
    """ACP content block → text (``{"content": {"text": ...}}``)."""
    content = data.get("content")
    if isinstance(content, Mapping):
        text = content.get("text")
        if text is not None:
            return _text(text)
    return ""


def _base_fields(event: Mapping[str, Any], ctx: AGUIContext) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    for key, value in (
        ("task_id", ctx.task_id),
        ("step_key", ctx.step_key),
        ("channel", ctx.channel),
        ("session_id", ctx.session_id),
        ("engine", ctx.engine),
        ("model", ctx.model),
    ):
        if value not in (None, ""):
            fields[key] = value
    if ctx.event_sequence is not None:
        fields["sequence"] = ctx.event_sequence
    if ctx.timestamp is not None:
        fields["timestamp"] = ctx.timestamp
    if ctx.created_at:
        fields["created_at"] = ctx.created_at
    return fields


def _custom(
    event: Mapping[str, Any],
    ctx: AGUIContext,
    name: str,
    value: Mapping[str, Any],
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": "CUSTOM",
        "name": name,
        "value": dict(value),
    }
    if ctx.message_id:
        payload["messageId"] = ctx.message_id
    payload.update(_base_fields(event, ctx))
    return payload


def _thread_run_ids(ctx: AGUIContext) -> tuple[str, str]:
    """RUN_* 的 threadId / runId：任务渠道用 task_id，助手渠道用 session_id。"""
    thread_id = ctx.task_id or ctx.session_id or ""
    run_id = ctx.session_id
    if ctx.task_id and ctx.step_key:
        run_id = f"{ctx.task_id}::{ctx.step_key}"
    return thread_id, run_id


def _run_event(
    event: Mapping[str, Any],
    ctx: AGUIContext,
    run_type: str,
    status: str,
    error: Any = None,
) -> dict[str, Any]:
    thread_id, run_id = _thread_run_ids(ctx)
    payload: dict[str, Any] = {
        "type": run_type,
        "threadId": thread_id,
        "runId": run_id,
    }
    if status:
        payload["status"] = status  # passthrough 原始状态，前端据此更新步骤状态
    if error is not None:
        payload["error"] = _text(error)
    if ctx.message_id:
        payload["messageId"] = ctx.message_id
    payload.update(_base_fields(event, ctx))
    return payload


def _map_status_event(
    event: Mapping[str, Any],
    ctx: AGUIContext,
    data: Mapping[str, Any],
) -> list[dict[str, Any]]:
    status = str(data.get("status") or "running")
    if status in _RUN_STARTED_STATUSES:
        return [_run_event(event, ctx, "RUN_STARTED", status)]
    if status in _RUN_FINISHED_STATUSES:
        return [_run_event(event, ctx, "RUN_FINISHED", status)]
    if status in _RUN_ERROR_STATUSES:
        return [_run_event(event, ctx, "RUN_ERROR", status, error=data.get("error"))]
    # 步骤级状态（reviewing / awaiting_review / retrying / rework …）
    return [_custom(event, ctx, "workstep.status", data)]


def to_agui_events(
    event: Mapping[str, Any] | Any,
    ctx: AGUIContext | None = None,
) -> list[dict[str, Any]]:
    """把一个内部事件翻译为 0~n 个 AG-UI 事件。

    ``event`` 可以是 InternalEvent、事件 dict（``type`` / ``data`` 键）。返回
    AG-UI 标准事件列表；无法识别的事件返回空列表（不静默丢弃未知 ACP update，
    那些已在引擎层转为 ``acp_raw``）。
    """
    if hasattr(event, "to_dict"):
        event = event.to_dict()
    if not isinstance(event, Mapping):
        return []
    ctx = ctx or AGUIContext.from_event(event)
    event_type = str(event.get("type") or "")
    data = event.get("data")
    if not isinstance(data, Mapping):
        data = {}

    if event_type == "agent_message_chunk":
        return [_message_chunk(event, ctx, role="assistant", delta=_extract_content_text(data))]
    if event_type == "user_message_chunk":
        return [_message_chunk(event, ctx, role="user", delta=_extract_content_text(data))]
    if event_type == "live_message":
        # 实时插入消息的引擎确认：以 user 角色 chunk 呈现（messageId 关联持久化消息）。
        return [_message_chunk(
            event,
            ctx,
            role="user",
            delta="",
            extra={"status": data.get("status"), "detail": data.get("detail")},
        )]
    if event_type == "agent_thought_chunk":
        return [_message_chunk(event, ctx, delta=_extract_content_text(data), reasoning=True)]
    if event_type == "tool_call":
        return _map_tool_call(event, ctx, data)
    if event_type == "tool_call_update":
        return _map_tool_call_update(event, ctx, data)
    if event_type == "status":
        return _map_status_event(event, ctx, data)
    if event_type == "message_started":
        return [_message_event(
            event, ctx, "TEXT_MESSAGE_START",
            role=str(data.get("role") or "assistant"),
            extra={
                **({"prompt": data["prompt"]} if data.get("prompt") is not None else {}),
                **({"content": data["content"]} if data.get("content") is not None else {}),
                **({"status": data["status"]} if data.get("status") is not None else {}),
            },
        )]
    if event_type == "message_snapshot":
        return [_message_event(
            event, ctx, "TEXT_MESSAGE_CONTENT",
            extra={**({"content": data["content"]} if data.get("content") is not None else {})},
        )]
    if event_type == "message_completed":
        return [_message_event(
            event, ctx, "TEXT_MESSAGE_END",
            extra={
                "status": str(data.get("status") or "succeeded"),
                **({"content": data["content"]} if data.get("content") is not None else {}),
                **({"error": data["error"]} if data.get("error") is not None else {}),
                **({"ended_at": data["ended_at"]} if data.get("ended_at") is not None else {}),
            },
        )]
    name = _CUSTOM_NAMES.get(event_type)
    if name is not None:
        return [_custom(event, ctx, name, data)]
    # 未知类型（例如引擎新事件未注册映射）：透传为 workstep.* 自定义事件，
    # 避免实时链路丢事件。
    return [_custom(event, ctx, f"workstep.{event_type}", data)]


def _message_chunk(
    event: Mapping[str, Any],
    ctx: AGUIContext,
    *,
    role: str = "assistant",
    delta: str,
    reasoning: bool = False,
    extra: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": "REASONING_MESSAGE_CHUNK" if reasoning else "TEXT_MESSAGE_CHUNK",
    }
    if ctx.message_id:
        payload["messageId"] = ctx.message_id
    if not reasoning:
        payload["role"] = role
    payload["delta"] = delta
    if extra:
        for key, value in extra.items():
            if value is not None:
                payload[key] = value
    payload.update(_base_fields(event, ctx))
    return payload


def _message_event(
    event: Mapping[str, Any],
    ctx: AGUIContext,
    message_type: str,
    *,
    role: str = "assistant",
    extra: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"type": message_type}
    if ctx.message_id:
        payload["messageId"] = ctx.message_id
    if message_type == "TEXT_MESSAGE_START":
        payload["role"] = role
    if extra:
        for key, value in extra.items():
            if value is not None:
                payload[key] = value
    payload.update(_base_fields(event, ctx))
    return payload


def _map_tool_call(
    event: Mapping[str, Any],
    ctx: AGUIContext,
    data: Mapping[str, Any],
) -> list[dict[str, Any]]:
    tool_call_id = str(data.get("tool_call_id") or "")
    start: dict[str, Any] = {"type": "TOOL_CALL_START", "toolCallId": tool_call_id}
    title = str(data.get("title") or data.get("name") or "tool")
    if title:
        start["name"] = title
    if data.get("kind"):
        start["kind"] = str(data["kind"])
    start["status"] = "pending"
    if data.get("needs_approval"):
        start["needsApproval"] = True
    if ctx.message_id:
        start["messageId"] = ctx.message_id
    start.update(_base_fields(event, ctx))

    args: dict[str, Any] = {
        "type": "TOOL_CALL_ARGS",
        "toolCallId": tool_call_id,
        "args": data.get("raw_input") if data.get("raw_input") is not None else {},
    }
    if ctx.message_id:
        args["messageId"] = ctx.message_id
    args.update(_base_fields(event, ctx))
    return [start, args]


def _map_tool_call_update(
    event: Mapping[str, Any],
    ctx: AGUIContext,
    data: Mapping[str, Any],
) -> list[dict[str, Any]]:
    tool_call_id = str(data.get("tool_call_id") or "")
    status = str(data.get("status") or "in_progress")
    if status in {"completed", "failed"}:
        output = (
            data.get("raw_output")
            if data.get("raw_output") is not None
            else ""
        )
        result: dict[str, Any] = {
            "type": "TOOL_CALL_RESULT",
            "toolCallId": tool_call_id,
            "output": output,
            "isError": status == "failed",
        }
        if ctx.message_id:
            result["messageId"] = ctx.message_id
        result.update(_base_fields(event, ctx))
        return [result]
    raw_input = data.get("raw_input")
    chunk: dict[str, Any] = {
        "type": "TOOL_CALL_CHUNK",
        "toolCallId": tool_call_id,
        "delta": _text(raw_input) if raw_input is not None else "",
        "status": status,
    }
    if ctx.message_id:
        chunk["messageId"] = ctx.message_id
    chunk.update(_base_fields(event, ctx))
    return [chunk]
