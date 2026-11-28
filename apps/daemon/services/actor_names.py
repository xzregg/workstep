"""Resolve saved person names without substituting the current host identity.

Call inside the project's database executor. Historical calls need no writes:
only records with the same stable actor ID can supply a missing display name.
"""

from models import ChatMessage, Message, Task, WorkflowRun

AUTOMATED_AUTHORS = {"assistant", "system", "scheduler", "coordinator"}


def project_actor_names() -> dict[str, str]:
    candidates = {}

    def remember(actor_id, name, username, timestamp):
        actor_id = (actor_id or "").strip()
        name = (name or "").strip()
        if not actor_id or not name:
            return
        stamp = timestamp.isoformat() if timestamp else ""
        # A later login/ID fallback must not erase an available display name.
        priority = int(name not in {actor_id, (username or "").strip()})
        candidate = (priority, stamp, name)
        if candidate > candidates.get(actor_id, (-1, "", "")):
            candidates[actor_id] = candidate

    for model in (Message, ChatMessage):
        for row in model.select(model.author_id, model.author_name, model.author_username,
                                model.created_at).where(
            (model.role == "user")
            & (model.author_type.is_null() | (model.author_type == "user"))
        ):
            remember(row.author_id, row.author_name, row.author_username, row.created_at)
        for row in model.select(model.initiated_by_user_id, model.initiated_by_name,
                                model.initiated_by_username,
                                model.created_at).where(model.initiated_by_name.is_null(False)):
            remember(row.initiated_by_user_id, row.initiated_by_name,
                     row.initiated_by_username, row.created_at)
    for row in Task.select(Task.creator_id, Task.creator_name, Task.creator_username, Task.created_at):
        remember(row.creator_id, row.creator_name, row.creator_username, row.created_at)
    for row in WorkflowRun.select(WorkflowRun.initiated_by_user_id,
                                   WorkflowRun.initiated_by_username,
                                   WorkflowRun.initiated_by_name, WorkflowRun.started_at):
        remember(row.initiated_by_user_id, row.initiated_by_name,
                 row.initiated_by_username, row.started_at)
    return {actor_id: name for actor_id, (_, _, name) in candidates.items()}


def message_initiator(message, names: dict[str, str]) -> tuple[str | None, str | None]:
    if message.author_type in AUTOMATED_AUTHORS:
        actor_id = message.initiated_by_user_id
        name = (names.get(actor_id) or message.initiated_by_name
                or message.initiated_by_username)
    else:
        actor_id = message.author_id
        name = names.get(actor_id) or message.author_name or message.author_username
    return actor_id, name
