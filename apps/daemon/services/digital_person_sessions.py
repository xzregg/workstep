"""Project-scoped session lookups for host digital-person queries."""

from models.chat_session import ChatMessage, ChatSession
from services import digital_person_affect as affect
from services.digital_person_memory import scope_for_session


async def _resolve(current, project_id, session_id, lookup, missing_message):
    project_id = project_id or (await current.home()).id
    if not current.projects.get_project_by_id(project_id):
        raise LookupError('Source project does not exist')

    def read(_):
        if not ChatSession.get_or_none(ChatSession.id == session_id, ChatSession.project_id == project_id):
            raise LookupError(missing_message)
        return lookup(session_id)

    return await current.projects.run_db(project_id, read)


async def memory_scope(current, project_id, session_id):
    return await _resolve(current, project_id, session_id, scope_for_session, '来源会话不存在')


async def affect_person(current, project_id, session_id):
    def lookup(sid):
        row = (ChatMessage.select().where(ChatMessage.session == sid, ChatMessage.role == 'user')
               .order_by(ChatMessage.created_at.desc()).first())
        message = {'author_id': row.author_id, 'author_device_id': row.author_device_id} if row else {}
        return affect.subject(message, scope_for_session(sid))

    return await _resolve(current, project_id, session_id, lookup, '会话不存在')
