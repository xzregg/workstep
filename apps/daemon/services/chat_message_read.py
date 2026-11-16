"""Read exactly one persisted chat message without consulting memory."""

from models.chat_session import ChatMessage, ChatSession
from services.chat_identity import session_project_id
from services.remote_access import get_current_actor


async def read_message(manager, session_id: str, message_id: str, project_id: str | None = None) -> dict | None:
    embedded = session_project_id(session_id)
    actor = get_current_actor()
    scope = actor.project_id if actor is not None else None
    if scope is not None and any(value and value != scope for value in (project_id, embedded)):
        raise PermissionError("Project scope denied")
    if embedded and project_id and embedded != project_id:
        raise ValueError("Session project does not match project_id")
    target = project_id or embedded or scope
    candidates = [target] if target else [item["id"] for item in manager.list_project_catalog()]

    def load(project):
        row = (ChatMessage.select(
            ChatMessage.id, ChatMessage.role, ChatMessage.content, ChatMessage.status,
            ChatMessage.engine, ChatMessage.model, ChatMessage.created_at, ChatMessage.ended_at,
            ChatMessage.author_id, ChatMessage.author_name, ChatMessage.author_type,
        ).join(ChatSession).where(
            ChatMessage.id == message_id, ChatSession.id == session_id,
            ChatSession.project_id == project.id,
        ).first())
        if row is None:
            return None
        return {
            "id": row.id, "project_id": project.id, "session_id": session_id,
            "role": row.role, "content": row.content, "status": row.status,
            "engine": row.engine, "model": row.model,
            "author_id": row.author_id, "author_name": row.author_name, "author_type": row.author_type,
            "created_at": row.created_at.isoformat(),
            "ended_at": row.ended_at.isoformat() if row.ended_at else None,
        }

    for candidate in candidates:
        if manager.get_project_by_id(candidate) is None:
            continue
        result = await manager.run_db(candidate, load)
        if result is not None:
            return result
    return None
