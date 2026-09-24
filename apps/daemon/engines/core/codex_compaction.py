"""Manual compaction of an existing Codex thread."""

import asyncio


async def compact_codex_thread(client, thread, *, timeout: float = 120) -> None:
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
    try:
        await thread.compact()
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise TimeoutError("等待 Codex 压缩完成事件超时")
            try:
                notification = await asyncio.wait_for(
                    asyncio.to_thread(route.next_notification), timeout=remaining,
                )
            except asyncio.TimeoutError as exc:
                raise TimeoutError("等待 Codex 压缩完成事件超时") from exc
            if getattr(notification, "method", None) != "thread/compacted":
                continue
            payload = getattr(notification, "payload", None)
            if payload is None:
                payload = getattr(notification, "params", None)
            thread_id = getattr(payload, "thread_id", None)
            if thread_id is None and isinstance(payload, dict):
                thread_id = payload.get("thread_id") or payload.get("threadId")
            if str(thread_id or "") == str(thread.id):
                return
    finally:
        fail = getattr(route, "fail", None)
        if callable(fail):
            fail(RuntimeError("压缩通知订阅已结束"))
        route.finish()
        notifications.unregister_goal_operation(route)
