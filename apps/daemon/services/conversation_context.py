"""Task-local WorkStep identity for engine execution, separate from prompts."""
from contextlib import contextmanager
from contextvars import ContextVar
import os
from threading import Lock

PROJECT_ENV = "WORKSTEP_PROJECT_ID"
SESSION_ENV = "WORKSTEP_SESSION_ID"
MESSAGE_ENV = "WORKSTEP_MESSAGE_ID"
SENDER_ID_ENV = "WORKSTEP_SENDER_ID"
SENDER_NAME_ENV = "WORKSTEP_SENDER_NAME"
MESSAGE_CONTEXT_ENV = (MESSAGE_ENV, SENDER_ID_ENV, SENDER_NAME_ENV)
_context: ContextVar[dict[str, str] | None] = ContextVar("workstep_conversation", default=None)
_active_senders: dict[tuple[str, str], dict[str, str]] = {}
_sender_lock = Lock()


@contextmanager
def conversation_context(project_id: str, session_id: str, *, message_id="", sender_id="", sender_name=""):
    env = {PROJECT_ENV: project_id, SESSION_ENV: session_id}
    if message_id:
        env[MESSAGE_ENV] = message_id
        if sender_id:
            env.update({SENDER_ID_ENV: sender_id, SENDER_NAME_ENV: sender_name})
    key = (project_id, session_id)
    sender = {"message_id": message_id}
    if sender_id:
        sender.update(sender_id=sender_id, sender_name=sender_name)
    if message_id:
        with _sender_lock:
            _active_senders[key] = sender
    token = _context.set(env)
    try:
        yield
    finally:
        _context.reset(token)
        if message_id:
            with _sender_lock:
                if _active_senders.get(key) is sender:
                    _active_senders.pop(key)


def active_conversation_sender(project_id: str, session_id: str):
    with _sender_lock:
        return _active_senders.get((project_id, session_id), {}).copy()


def conversation_env() -> dict[str, str]:
    value = _context.get()
    return dict(value) if value else {}


def execution_env(base: dict[str, str]) -> dict[str, str]:
    env = dict(base)
    for key in (PROJECT_ENV, SESSION_ENV, *MESSAGE_CONTEXT_ENV):
        env.pop(key, None)
    env.update(conversation_env())
    return env


def current_conversation() -> dict:
    # Native tools use task-local state; CLI processes inherit only their own
    # execution environment. Never alter the daemon's global os.environ.
    env = conversation_env() if _context.get() is not None else os.environ
    project = env.get(PROJECT_ENV, "")
    session = env.get(SESSION_ENV, "")
    if not project or not session:
        return {"ok": False, "error": "Current execution environment lacks WorkStep session information"}
    result = {"project_id": project, "session_id": session}
    if env.get(MESSAGE_ENV):
        result["message_id"] = env[MESSAGE_ENV]
        if env.get(SENDER_ID_ENV):
            result.update(sender_id=env[SENDER_ID_ENV], sender_name=env.get(SENDER_NAME_ENV, ""))
    return result
