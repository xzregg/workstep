"""Synchronous chat admission work unit; caller must use the project executor."""

from models.chat_session import ChatMessage


def submit_turn(module, project_id, session_id, content, idempotency_key, **options):
    # Resolve the saved endpoint in the same work unit that accepts the turn.
    config = module.get_execution_config(project_id, session_id)
    accepted = module.submit_message(
        project_id, session_id, content, idempotency_key,
        engine=config['engine'], model=config['model'], fast_model=config['fast_model'],
        vision_model=config['vision_model'], provider_id=config['provider_id'] or '',
        thinking_effort=config['thinking_effort'], service_tier=config['service_tier'],
        schedule=False, **options,
    )
    message = ChatMessage.get_or_none(
        ChatMessage.id == accepted.assistant_message_id, ChatMessage.session == session_id)
    actual = {'engine': message.engine, 'model': message.model} if message else {}
    return accepted, config, actual
