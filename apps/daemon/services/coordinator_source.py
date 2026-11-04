"""Carry coordinator provenance to native tools and child-process CLI calls."""

from contextlib import contextmanager
from contextvars import ContextVar

COORDINATOR_TURN_ENV = "WORKSTEP_COORDINATOR_TURN_ID"
COORDINATOR_TURN_HEADER = "X-WorkStep-Coordinator-Turn"
_turn_id: ContextVar[str | None] = ContextVar("coordinator_source_turn", default=None)


@contextmanager
def coordinator_source(turn_id: str | None):
    token = _turn_id.set(turn_id)
    try:
        yield
    finally:
        _turn_id.reset(token)


def coordinator_source_env() -> dict[str, str]:
    turn_id = _turn_id.get()
    return {COORDINATOR_TURN_ENV: turn_id} if turn_id else {}


def coordinator_message_fields(task, turn_id: str) -> dict:
    """Resolve a verified source in the project's database executor."""
    from models import CoordinatorTurn

    turn = CoordinatorTurn.get_or_none(
        (CoordinatorTurn.id == turn_id) & (CoordinatorTurn.task == task)
        & (CoordinatorTurn.status == "running")
    )
    if turn is None:
        raise ValueError("协调消息来源已失效或不属于当前任务")
    user = turn.user_message
    return {
        "author_id": "coordinator", "author_username": "coordinator",
        "author_name": "协调助手", "author_type": "coordinator",
        "reply_to_message_id": turn.assistant_message_id,
        "initiated_by_user_id": user.initiated_by_user_id or user.author_id,
        "initiated_by_username": user.initiated_by_username or user.author_username,
        "author_device_id": user.author_device_id,
        "author_device_name": user.author_device_name,
    }


def message_actor(message) -> dict:
    """Use persisted provenance for live events, matching history."""
    return {"id": message.author_id, "name": message.author_name,
            "type": message.author_type, "username": message.author_username,
            "device_id": message.author_device_id, "device_name": message.author_device_name,
            "initiated_by_user_id": message.initiated_by_user_id,
            "initiated_by_username": message.initiated_by_username,
            "source_message_id": message.reply_to_message_id}
