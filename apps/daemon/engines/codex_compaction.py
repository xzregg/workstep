"""Manual compaction of an existing Codex thread."""

import asyncio
import json
import os
from pathlib import Path


def _find_rollout_path(thread_id: str, reported_path: str | None) -> Path | None:
    if reported_path:
        path = Path(reported_path)
        if path.is_file():
            return path
    sessions = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "sessions"
    return next(sessions.rglob(f"*{thread_id}.jsonl"), None)


def _read_rollout_completion(
    path: Path, offset: int, saw_compacted: bool,
) -> tuple[int, bool, bool]:
    with path.open("rb") as stream:
        stream.seek(offset)
        while line := stream.readline():
            if not line.endswith(b"\n"):
                break
            offset = stream.tell()
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if record.get("type") == "compacted":
                saw_compacted = True
            elif saw_compacted and record.get("type") == "event_msg" and (
                record.get("payload") or {}
            ).get("type") == "task_complete":
                return offset, saw_compacted, True
    return offset, saw_compacted, False


async def compact_codex_thread(
    client, thread, *, timeout: float = 120, poll_interval: float = 2,
) -> None:
    """Start native compaction and wait until Codex confirms this thread."""
    notifications = getattr(client, "_client", None)
    if notifications is None or not callable(
        getattr(notifications, "register_goal_operation", None)
    ):
        raise RuntimeError("当前 Codex SDK 不支持接收压缩完成事件")
    if not callable(getattr(thread, "compact", None)):
        raise RuntimeError("当前 Codex SDK 不支持手动压缩")

    # thread/compacted carries a turn ID, so the SDK routes it to a turn
    # subscription instead of its global notification queue. Register a
    # thread-scoped route before starting compaction to avoid losing the event.
    route = notifications.register_goal_operation(str(thread.id))
    read_thread = getattr(thread, "read", None)
    previous_turn_ids: set[str] | None = None
    compaction_turn_ids: set[str] = set()
    rollout_path: Path | None = None
    rollout_offset = 0
    saw_compacted = False
    notification_task = None
    before = None
    try:
        if callable(read_thread):
            try:
                before = await read_thread(include_turns=True)
                previous_turn_ids = {
                    str(turn.id) for turn in before.thread.turns
                }
            except Exception:
                # Older SDKs may not support reading turns. The native
                # completion notification remains the primary signal.
                previous_turn_ids = None
        reported_path = getattr(getattr(before, "thread", None), "path", None)
        rollout_path = await asyncio.to_thread(
            _find_rollout_path, str(thread.id), reported_path,
        )
        if rollout_path is not None:
            rollout_offset = await asyncio.to_thread(lambda: rollout_path.stat().st_size)
        await thread.compact()
        deadline = asyncio.get_running_loop().time() + timeout
        notification_task = asyncio.create_task(
            asyncio.to_thread(route.next_notification)
        )
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise TimeoutError("等待 Codex 压缩完成事件超时")
            done, _ = await asyncio.wait(
                {notification_task}, timeout=min(poll_interval, remaining),
            )
            if done:
                notification = notification_task.result()
                method = getattr(notification, "method", None)
                payload = getattr(notification, "payload", None)
                if payload is None:
                    payload = getattr(notification, "params", None)
                thread_id = getattr(payload, "thread_id", None)
                if thread_id is None and isinstance(payload, dict):
                    thread_id = payload.get("thread_id") or payload.get("threadId")
                if str(thread_id or "") == str(thread.id):
                    if method == "thread/compacted":
                        return
                    if method == "item/completed" and getattr(
                        getattr(payload, "item", None), "type", None,
                    ) == "contextCompaction":
                        compaction_turn_ids.add(str(payload.turn_id))
                    if method == "turn/completed":
                        turn = getattr(payload, "turn", None)
                        status = getattr(getattr(turn, "status", None), "value", None)
                        if status is None:
                            status = getattr(turn, "status", None)
                        if status == "completed" and (
                            str(getattr(turn, "id", "")) in compaction_turn_ids
                            or any(
                                getattr(item, "type", None) == "contextCompaction"
                                for item in getattr(turn, "items", [])
                            )
                        ):
                            return
                notification_task = asyncio.create_task(
                    asyncio.to_thread(route.next_notification)
                )
            if previous_turn_ids is not None:
                try:
                    current = await read_thread(include_turns=True)
                except Exception:
                    pass
                else:
                    for turn in current.thread.turns:
                        status = getattr(turn.status, "value", turn.status)
                        if str(turn.id) in previous_turn_ids or status != "completed":
                            continue
                        if any(
                            getattr(item, "type", None) == "contextCompaction"
                            for item in turn.items
                        ):
                            return
            if rollout_path is not None:
                rollout_offset, saw_compacted, complete = await asyncio.to_thread(
                    _read_rollout_completion, rollout_path, rollout_offset, saw_compacted,
                )
                if complete:
                    return
    finally:
        fail = getattr(route, "fail", None)
        if callable(fail):
            fail(RuntimeError("压缩通知订阅已结束"))
        if notification_task is not None:
            notification_task.cancel()
            await asyncio.gather(notification_task, return_exceptions=True)
        route.finish()
        notifications.unregister_goal_operation(route)
