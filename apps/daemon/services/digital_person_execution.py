"""Save digital-person defaults together with their registered conversation."""
from models.chat_session import ChatSession
from services.digital_person_runtime import read_state


async def save_execution_config(runtime, name: str, selection: dict, save_defaults):
    home = await runtime.home()
    reflection = name == 'digital_person_reflection'

    def operation(_):
        state = read_state(home.id)
        if reflection:
            if runtime._check_lock.locked() or runtime._active_check is not None:
                raise ValueError('Chat session is running')
            legacy = list((state.get('check_sessions_by_scope') or {}).values())
            known = list(dict.fromkeys(state.get('check_sessions', []) + legacy))
            session_id = state.get('check_session_id') or (known[-1] if known else None)
            if session_id == state.get('main_session_id'):
                session_id = None
        else:
            session_id = state.get('main_session_id')
        row = ChatSession.get_or_none(
            ChatSession.id == session_id, ChatSession.archived == False,
            ChatSession.project_id == home.id,
        ) if session_id else None
        if row is None:
            return save_defaults(), None, False
        endpoint_changed = (row.engine != selection['engine']
                            or (row.provider_id or '') != selection['provider_id'])
        # Reuse the shared transitions for busy checks, versioning and handoff.
        session = runtime.chats._sessions.get(runtime.chats._session_identity(home.id, row.id)[0])
        previous = {key: getattr(session, key) for key in (
            'engine', 'model', 'fast_model', 'vision_model', 'resolved_session_id',
            'engine_state', 'session_provider',
        )} if session is not None else {}
        if session is not None:
            previous['extra'] = dict(session.extra)
        try:
            with ChatSession._meta.database.atomic():
                if endpoint_changed:
                    runtime.chats.handoff_session(
                        home.id, row.id, engine=selection['engine'],
                        provider_id=selection['provider_id'], context_mode='smart',
                        **{key: selection[key] for key in ('model', 'fast_model', 'vision_model')},
                    )
                snapshot = runtime.chats.update_execution_config(home.id, row.id, {
                    key: selection[key] for key in ('model', 'fast_model', 'vision_model', 'thinking_effort')
                })
                saved = save_defaults()
        except Exception:
            # Handoff also updates an idle in-memory session; roll it back with SQLite.
            for key, value in previous.items():
                setattr(session, key, value)
            raise
        return saved, snapshot, endpoint_changed

    saved, snapshot, endpoint_changed = await runtime.projects.run_db(home.id, operation)
    if snapshot is not None:
        if endpoint_changed and not reflection:
            from services.chat_session_retention import release_main_session_retention
            await release_main_session_retention(home.id, snapshot['id'])
        await runtime.chats.publish_execution_config(snapshot)
    return saved
