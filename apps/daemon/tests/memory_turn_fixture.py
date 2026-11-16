"""Explicit completed-turn fixtures for tests that previously seeded lone users."""
from datetime import timedelta
from models.chat_session import ChatMessage


def create_completed_user(**values):
    user=ChatMessage.create(**values)
    at=user.created_at+timedelta(milliseconds=1)
    reply=ChatMessage.create(id='fixture-reply-'+user.id,session=user.session_id,role='assistant',
                       content='已收到。',status='succeeded',created_at=at,ended_at=at)
    from services import memory_knowledge
    from services.digital_person_memory import capture_message,scope_for_session
    memory_knowledge.ensure_schema()
    capture_message(reply,scope_for_session(user.session_id))
    return user


def create_completed_reply(**values):
    reply=ChatMessage.create(**values)
    from services.digital_person_memory import capture_message,scope_for_session
    capture_message(reply,scope_for_session(reply.session_id))
    return reply


async def assessment_access(current):
    from services.conversation_context import current_conversation
    from services.memory_query import execution_access
    context=current_conversation()
    assert context.get('ok') is not False,context
    return await execution_access(current.projects,context['project_id'],context['session_id'])
