"""Task-local WorkStep identity for engine execution, separate from prompts."""
from contextlib import contextmanager
from contextvars import ContextVar
import os

PROJECT_ENV = "WORKSTEP_PROJECT_ID"
SESSION_ENV = "WORKSTEP_SESSION_ID"
_context: ContextVar[tuple[str, str] | None] = ContextVar("workstep_conversation", default=None)


@contextmanager
def conversation_context(project_id: str, session_id: str):
    token = _context.set((project_id, session_id))
    try:
        yield
    finally:
        _context.reset(token)


def conversation_env() -> dict[str, str]:
    value = _context.get()
    return {PROJECT_ENV: value[0], SESSION_ENV: value[1]} if value else {}


def execution_env(base: dict[str, str]) -> dict[str, str]:
    env = dict(base)
    for key in (PROJECT_ENV, SESSION_ENV):
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
        return {"ok": False, "error": "当前执行环境没有 WorkStep 会话信息"}
    return {"project_id": project, "session_id": session}
