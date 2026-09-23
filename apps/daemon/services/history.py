"""History replay — reconstruct past executions from stored events."""

import json
import logging
from pathlib import Path, PurePosixPath

from agent_assistants.event_journal import TurnEventJournal
from agent_assistants.event_truncation import truncate_large_tool_payloads
from engines.codex_visualize import (
    CODEX_ENGINE_IDS,
    convert_event_visualize_markers,
    convert_visualize_markers,
)
from engines.core.agui import AGUIContext, to_agui_events
from engines.core.events import map_legacy_event
from models.message import Message
from models.run import StepRun, WorkflowRun
from models.task import Task

logger = logging.getLogger(__name__)
_event_journal = TurnEventJournal()


def message_artifact_projections(
    task_id: str,
    messages: list[Message],
) -> dict[str, tuple[str | None, int | None]]:
    """Resolve the concrete step/artifact run for new and legacy messages."""
    runs_by_step: dict[str, list[StepRun]] = {}
    for step_run in (
        StepRun.select()
        .join(WorkflowRun)
        .where(WorkflowRun.task == task_id)
        .order_by(StepRun.started_at, StepRun.attempt)
    ):
        runs_by_step.setdefault(step_run.step_key, []).append(step_run)

    projections: dict[str, tuple[str | None, int | None]] = {}
    for message in messages:
        if message.step_run_id or message.artifact_round is not None:
            projections[message.id] = (
                message.step_run_id,
                message.artifact_round,
            )
            continue
        message_time = message.started_at or message.created_at
        candidates = [
            step_run
            for step_run in runs_by_step.get(message.step_key, [])
            if step_run.started_at is not None
            and message_time is not None
            and step_run.started_at <= message_time
        ]
        if candidates:
            step_run = candidates[-1]
            projections[message.id] = (step_run.id, step_run.artifact_round)
        else:
            projections[message.id] = (None, None)
    return projections


def session_id_from_events(events: list[dict]) -> str | None:
    """Return the engine session owned by one persisted message segment."""
    for event in events:
        if not isinstance(event, dict) or event.get("type") != "session_started":
            continue
        data = event.get("data")
        if isinstance(data, dict) and data.get("session_id"):
            return str(data["session_id"])
    return None


def session_id_from_journal_path(msg: Message) -> str | None:
    """Recover the session owned by a message segment without replaying its log."""
    if not msg.event_log_path:
        return None
    parts = PurePosixPath(msg.event_log_path).parts
    if (
        len(parts) == 4
        and parts[0] == "event_logs"
        and parts[1] == f"task-{msg.task_id}"
        and parts[3] == f"{msg.id}.jsonl"
    ):
        return parts[2]
    return None


def event_detail(msg: Message) -> dict | None:
    if not msg.event_log_path:
        return None
    try:
        summary = json.loads(msg.event_summary_json or "{}")
    except json.JSONDecodeError:
        summary = {}
    return {
        "available": True,
        "loaded": False,
        "event_count": msg.event_count or 0,
        "last_event_seq": msg.last_event_seq or 0,
        **summary,
    }


def translate_events(
    events: list[dict],
    *,
    task_id: str | None = None,
    step_key: str | None = None,
    message_id: str | None = None,
    channel: str | None = None,
    engine: str | None = None,
    model: str | None = None,
) -> list[dict]:
    """历史回放统一读路径：旧词汇 → 新词汇 → AG-UI 翻译。

    与实时 WebSocket 推送共用 ``engines/core/agui.py`` 翻译层，保证前端
    store 只消费 AG-UI。
    """
    ctx = AGUIContext(
        task_id=task_id,
        step_key=step_key,
        message_id=message_id,
        channel=channel,
        engine=engine,
        model=model,
    )
    result: list[dict] = []
    for event in events:
        if not isinstance(event, dict):
            continue
        if engine in CODEX_ENGINE_IDS:
            event = convert_event_visualize_markers(event)
        # 出口统一截断超大工具载荷（与 chat 历史 / WS 广播出口一致）：任务历史
        # 回放整包随 HTTP 下发，数十 MB 的 raw_output 会直接进前端 store，
        # 多消息叠加后压垮渲染进程；完整内容展开时经 messageEvents 按需分页拉取。
        mapped = truncate_large_tool_payloads(map_legacy_event(event))
        ctx.event_sequence = (
            event.get("event_sequence")
            if event.get("event_sequence") is not None
            else event.get("sequence", event.get("seq"))
        )
        ctx.timestamp = event.get("timestamp")
        ctx.created_at = event.get("created_at")
        result.extend(to_agui_events(mapped, ctx))
    return result


def restore_running_projection(
    entry: dict,
    msg: Message,
    workstep_dir: str | Path | None,
) -> None:
    if msg.run_status != "running" or not msg.event_log_path or workstep_dir is None:
        return
    try:
        ref = _event_journal.reopen(workstep_dir, msg.event_log_path)
        snapshot = _event_journal.snapshot(ref)
    except Exception:
        logger.exception("Failed to restore running task message %s", msg.id)
        return
    # 审核消息先以「审核中」占位落库，journal 起初可能还没有任何 chunk。
    # 此时不能用空 journal 覆盖占位内容，否则前端会把运行中的审核消息
    # 当作空消息过滤掉，表现为「审核中」迟迟不显示。
    snapshot_content = convert_visualize_markers(snapshot["content"] or "")
    if snapshot_content:
        entry["content"] = snapshot_content
    entry["session_id"] = (
        session_id_from_events(snapshot["events"])
        or entry.get("session_id")
        or session_id_from_journal_path(msg)
    )
    entry["events"] = translate_events(
        snapshot["events"],
        task_id=str(msg.task_id),
        step_key=msg.step_key,
        message_id=msg.id,
        channel=msg.channel,
        engine=msg.engine,
        model=msg.model,
    )
    entry["event_detail"] = {
        "available": True,
        "loaded": False,
        **snapshot["summary"],
    }


def get_task_history(
    task_id: str,
    workstep_dir: str | Path | None = None,
) -> list[dict]:
    """Get all messages for a task with their events, ordered by position.

    Returns a list of message dicts with parsed events for replay.
    """
    messages = (
        Message.select()
        .where(Message.task == task_id)
        .order_by(Message.position)
    )

    result = []
    for msg in messages:
        entry = {
            "id": msg.id,
            "step_key": msg.step_key,
            "role": msg.role,
            "content": convert_visualize_markers(msg.content or ""),
            "engine": msg.engine,
            "model": msg.model,
            "run_id": msg.run_id,
            "run_status": msg.run_status,
            "position": msg.position,
            "started_at": msg.started_at,
            "ended_at": msg.ended_at,
            "events": [],
            "prompt": None,
            "usage": None,
            "session_id": session_id_from_journal_path(msg),
        }

        # Parse events_json → AG-UI（旧词汇经兼容映射）
        raw_events: list[dict] = []
        if msg.events_json:
            try:
                raw_events = json.loads(msg.events_json)
            except json.JSONDecodeError:
                logger.warning("Invalid events_json for message %s", msg.id)
        entry["session_id"] = (
            session_id_from_events(raw_events) or entry["session_id"]
        )
        entry["events"] = translate_events(
            raw_events,
            task_id=task_id,
            step_key=msg.step_key,
            message_id=msg.id,
            channel=msg.channel,
            engine=msg.engine,
            model=msg.model,
        )
        detail = event_detail(msg)
        if detail is not None:
            entry["event_detail"] = detail
        restore_running_projection(entry, msg, workstep_dir)

        # Parse usage_json
        if msg.usage_json:
            try:
                entry["usage"] = json.loads(msg.usage_json)
            except json.JSONDecodeError:
                pass

        if msg.prompt_json:
            try:
                entry["prompt"] = json.loads(msg.prompt_json).get("prompt")
            except (json.JSONDecodeError, AttributeError):
                pass

        result.append(entry)

    return result


def get_step_history(
    task_id: str,
    step_key: str,
    workstep_dir: str | Path | None = None,
) -> list[dict]:
    """Get messages for a specific step within a task."""
    messages = (
        Message.select()
        .where(
            (Message.task == task_id) &
            (Message.step_key == step_key)
        )
        .order_by(Message.position)
    )

    result = []
    for msg in messages:
        entry = {
            "id": msg.id,
            "role": msg.role,
            "content": convert_visualize_markers(msg.content or ""),
            "run_status": msg.run_status,
            "events": [],
            "prompt": None,
            "usage": None,
            "session_id": None,
        }
        if msg.events_json:
            try:
                raw_events = json.loads(msg.events_json)
            except json.JSONDecodeError:
                raw_events = []
            entry["session_id"] = session_id_from_events(raw_events)
            entry["events"] = translate_events(
                raw_events,
                task_id=task_id,
                step_key=step_key,
                message_id=msg.id,
                channel=msg.channel,
                engine=msg.engine,
                model=msg.model,
            )
        detail = event_detail(msg)
        if detail is not None:
            entry["event_detail"] = detail
        restore_running_projection(entry, msg, workstep_dir)
        if msg.prompt_json:
            try:
                entry["prompt"] = json.loads(msg.prompt_json).get("prompt")
            except (json.JSONDecodeError, AttributeError):
                pass
        if msg.usage_json:
            try:
                entry["usage"] = json.loads(msg.usage_json)
            except json.JSONDecodeError:
                pass
        result.append(entry)

    return result


def get_message_events(
    task_id: str,
    message_id: str,
    workstep_dir: str | Path,
    *,
    cursor: int = 0,
    limit: int = 30000,
) -> dict:
    """Read one task message's detailed timeline without loading it in history."""
    msg = Message.get_or_none(
        (Message.id == message_id) & (Message.task == task_id)
    )
    if msg is None:
        raise ValueError("Task message not found")
    if msg.event_log_path:
        ref = _event_journal.reopen(workstep_dir, msg.event_log_path)
        page = _event_journal.timeline(ref, cursor=cursor, limit=limit)
        page["events"] = translate_events(
            page["events"],
            task_id=task_id,
            step_key=msg.step_key,
            message_id=msg.id,
            channel=msg.channel,
            engine=msg.engine,
            model=msg.model,
        )
        return {"message_id": message_id, **page}

    try:
        legacy = json.loads(msg.events_json or "[]")
    except json.JSONDecodeError:
        legacy = []
    start = max(0, cursor)
    bounded = min(max(1, limit), 30000)
    raw_events = legacy[start:start + bounded]
    next_cursor = start + len(raw_events)
    return {
        "message_id": message_id,
        "events": translate_events(
            raw_events,
            task_id=task_id,
            step_key=msg.step_key,
            message_id=msg.id,
            channel=msg.channel,
            engine=msg.engine,
            model=msg.model,
        ),
        "event_count": len(legacy),
        "last_event_seq": next_cursor,
        "next_cursor": next_cursor if next_cursor < len(legacy) else None,
        "complete": next_cursor >= len(legacy),
    }


def replay_events(events: list[dict]):
    """Generator that yields events in order for frontend replay.

    Useful for SSE/WS streaming of historical events.
    """
    for event in events:
        yield event
