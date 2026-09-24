"""Share service — create, verify, and revoke task share links.

Each task has at most one active share. A share is gated by a password;
on successful unlock the service mints a short-lived session token that
is used for REST and WebSocket access to the share view.
"""

import hashlib
import hmac
import logging
import secrets
import uuid

from engines.codex_visualize import convert_visualize_markers
from models import Task, TaskShare, Workflow
from models.fields import utc_now

logger = logging.getLogger(__name__)

# Session tokens are kept in memory — they expire when the daemon restarts,
# which is acceptable for a local-first read-only share view.
_SHARE_SESSIONS: dict[str, dict] = {}  # session_token → {share_id, task_id, project_id}

SHARE_MODES = {"read_only", "interactive"}


def _hash_password(password: str, salt: str) -> str:
    """PBKDF2-SHA256 password hash (100k iterations, 32-byte digest)."""
    dk = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), 100_000, dklen=32
    )
    return dk.hex()


def _generate_token() -> str:
    """URL-safe random token for share links."""
    return secrets.token_urlsafe(24)


def _generate_session_token() -> str:
    return secrets.token_urlsafe(32)


def get_share_for_task(task_id: str) -> dict | None:
    """Return the active (non-revoked) share for a task, or None."""
    try:
        share = (
            TaskShare.select()
            .where((TaskShare.task == task_id) & (TaskShare.revoked == 0))
            .get()
        )
    except TaskShare.DoesNotExist:
        return None
    return _share_to_dict(share)


def create_share(
    task_id: str,
    password: str | None = None,
    title: str | None = None,
    mode: str = "read_only",
) -> dict:
    """Create or replace a share link for a task.

    If the password is empty/None, the share link will be publicly
    accessible without a password. If an existing share (active or
    revoked) exists for this task it is deleted first so the
    unique(task_id) constraint is respected.
    """
    if mode not in SHARE_MODES:
        raise ValueError("unsupported share mode")
    try:
        Task.get_by_id(task_id)
    except Task.DoesNotExist as exc:
        raise ValueError("task not found") from exc

    # Wipe any previous share for this task (active or revoked).
    TaskShare.delete().where(TaskShare.task == task_id).execute()

    now = utc_now()
    password = password or None  # normalize empty string to None
    if password:
        salt = secrets.token_hex(16)
        password_hash = _hash_password(password, salt)
    else:
        salt = None
        password_hash = None

    share = TaskShare.create(
        id=str(uuid.uuid4()),
        task=task_id,
        token=_generate_token(),
        title=title or None,
        password_hash=password_hash,
        salt=salt,
        mode=mode,
        revoked=0,
        created_at=now,
    )
    logger.info("Created share %s for task %s", share.token, task_id)
    return _share_to_dict(share)


def revoke_share(task_id: str) -> bool:
    """Revoke any active share for a task. Returns True if a share was revoked."""
    now = utc_now()
    updated = (
        TaskShare.update(revoked=1, revoked_at=now)
        .where((TaskShare.task == task_id) & (TaskShare.revoked == 0))
        .execute()
    )
    if updated:
        logger.info("Revoked share for task %s", task_id)
    return bool(updated)


def resolve_share_by_token(token: str) -> dict | None:
    """Look up an active share by its public token.

    Returns the share plus its associated task_id and project_id.
    The project_id is derived by iterating registered projects because
    TaskShare rows live inside per-project databases.
    """
    from services.project import project_manager
    from models import db_proxy
    for project in project_manager.iter_projects():
        if project.db.is_closed():
            try:
                project.db.connect(reuse_if_open=True)
            except Exception:
                continue
        token_ctx = db_proxy.activate(project.db)
        try:
            share = (
                TaskShare.select()
                .where((TaskShare.token == token) & (TaskShare.revoked == 0))
                .get()
            )
        except TaskShare.DoesNotExist:
            continue
        finally:
            db_proxy.reset(token_ctx)
        return {
            "share": _share_to_dict(share, include_project=True, project_id=project.id),
            "task_id": share.task_id,
            "project_id": project.id,
        }
    return None


def verify_share_password(token: str, password: str) -> str | None:
    """Verify the password for a share and mint a session token on success.

    If the share has no password set, any password (including empty)
    is accepted and a session token is minted immediately.
    """
    from services.project import project_manager
    from models import db_proxy
    for project in project_manager.iter_projects():
        if project.db.is_closed():
            try:
                project.db.connect(reuse_if_open=True)
            except Exception:
                continue
        token_ctx = db_proxy.activate(project.db)
        try:
            share = (
                TaskShare.select()
                .where((TaskShare.token == token) & (TaskShare.revoked == 0))
                .get()
            )
        except TaskShare.DoesNotExist:
            continue
        finally:
            db_proxy.reset(token_ctx)
        # If share has no password, any password (or none) is accepted.
        if share.password_hash is not None:
            if _hash_password(password, share.salt) != share.password_hash:
                return None
        session_token = _generate_session_token()
        _SHARE_SESSIONS[session_token] = {
            "share_id": share.id,
            "token": share.token,
            "task_id": share.task_id,
            "project_id": project.id,
            "mode": share.mode,
        }
        return session_token
    return None


def resolve_share_session(session_token: str) -> dict | None:
    """Resolve a session token to its share context, or None if invalid."""
    ctx = _SHARE_SESSIONS.get(session_token)
    if not ctx:
        return None
    # TaskShare rows live inside per-project databases and the global
    # db_proxy may be bound to any project, so scan registered projects
    # (same pattern as resolve_share_by_token / verify_share_password).
    from services.project import project_manager
    from models import db_proxy
    for project in project_manager.iter_projects():
        if project.db.is_closed():
            try:
                project.db.connect(reuse_if_open=True)
            except Exception:
                continue
        token_ctx = db_proxy.activate(project.db)
        try:
            share = (
                TaskShare.select()
                .where(
                    (TaskShare.id == ctx["share_id"])
                    & (TaskShare.revoked == 0)
                )
                .get()
            )
        except TaskShare.DoesNotExist:
            continue
        finally:
            db_proxy.reset(token_ctx)
        return {
            "share_id": share.id,
            "token": share.token,
            "task_id": share.task_id,
            "project_id": ctx["project_id"],
            "mode": share.mode or "read_only",
        }
    # The share was revoked or its project is no longer registered.
    _SHARE_SESSIONS.pop(session_token, None)
    return None


def invalidate_session(session_token: str) -> None:
    _SHARE_SESSIONS.pop(session_token, None)


def load_shared_task(task_id: str) -> dict | None:
    """Load the canonical task-detail payload, minus private project/session data."""
    try:
        task = Task.get_by_id(task_id)
    except Task.DoesNotExist:
        return None
    from services.task import TaskService  # local import to avoid cycles

    import json as _json
    canonical = TaskService._task_to_dict(task)
    shared_fields = (
        "id",
        "title",
        "description",
        "status",
        "engine",
        "model",
        "coordinator_engine",
        "coordinator_model",
        "coordinator_fast_model",
        "run_round",
        "restart_from_step_key",
        "recovered_at",
        "recovered_count",
        "state_version",
        "workflow_id",
        "first_message_at",
        "completed_at",
        "duration_ms",
        "total_tokens",
        "created_at",
        "updated_at",
        "creator_id",
        "creator_name",
        "creator_device_id",
        "creator_device_name",
        "scheduled_start_at",
        "scheduled_start_state",
        "scheduled_start_error",
    )
    payload = {key: canonical.get(key) for key in shared_fields}
    payload["steps"] = [
        {key: value for key, value in step.items() if key != "session_id"}
        for step in canonical["steps"]
    ]
    workflow = None
    if task.workflow_id:
        try:
            wf = Workflow.get_by_id(task.workflow_id)
            workflow = {
                "id": wf.id,
                "name": wf.name,
                "steps": _json.loads(wf.steps_json) if wf.steps_json else None,
            }
        except Workflow.DoesNotExist:
            workflow = None
    payload["workflow"] = workflow
    return payload


def load_shared_history(
    task_id: str,
    limit: int = 200,
    offset: int = 0,
    mode: str = "read_only",
) -> list[dict]:
    """Load message history for a shared task.

    Only the ``execution`` channel is exposed through the share view; the
    coordinator channel contains the user's private planning dialog and
    must never leak to an external viewer.
    """
    from models import Message
    messages = list(
        Message.select()
        .where(
            (Message.task == task_id)
            & (Message.channel == "execution")
        )
        .order_by(Message.sequence.desc(), Message.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    result = []
    import json as _json
    from services.history import event_detail, message_artifact_projections, translate_events
    artifact_projections = message_artifact_projections(task_id, messages)
    for msg in reversed(messages):
        step_run_id, artifact_round = artifact_projections[msg.id]
        raw_events: list[dict] = []
        if msg.events_json:
            try:
                raw_events = _json.loads(msg.events_json)
            except Exception:
                raw_events = []
        # 与实时推送共用 AG-UI 翻译层（旧词汇经兼容映射），
        # 再按 CUSTOM name 脱敏。
        events = _scrub_events(translate_events(
            raw_events,
            task_id=task_id,
            step_key=msg.step_key,
            message_id=msg.id,
            channel=msg.channel,
            engine=msg.engine,
            model=msg.model,
        ), mode=mode)
        entry = {
            "id": msg.id,
            "role": msg.role,
            "content": convert_visualize_markers(msg.content or ""),
            "step_key": msg.step_key,
            "context_step_key": msg.context_step_key,
            "channel": msg.channel,
            "sequence": msg.sequence,
            "run_status": msg.run_status,
            "step_run_id": step_run_id,
            "artifact_round": artifact_round,
            "engine": msg.engine,
            "model": msg.model,
            "started_at": msg.started_at,
            "ended_at": msg.ended_at,
            "created_at": msg.created_at,
            "events": events,
            "usage": _json.loads(msg.usage_json) if msg.usage_json else None,
        }
        detail = event_detail(msg)
        if detail is not None:
            entry["event_detail"] = detail
        result.append(entry)
    return result


_SCRUBBED_CUSTOM_NAMES = {
    "workstep.interaction_request",
    "workstep.interaction_response",
    "workstep.engine_state",
}


def _scrub_events(events: list[dict], mode: str = "read_only") -> list[dict]:
    """Drop events that shouldn't be visible to external share viewers.

    AG-UI 统一词汇下按 ``CUSTOM name`` 脱敏（``workstep.interaction_*``、
    ``workstep.engine_state``）。
    """
    return [
        event
        for event in events
        if not (
            event.get("type") == "CUSTOM"
            and event.get("name") in _SCRUBBED_CUSTOM_NAMES
        )
    ]


def _share_to_dict(
    share: TaskShare,
    include_project: bool = False,
    project_id: str | None = None,
) -> dict:
    payload = {
        "id": share.id,
        "task_id": share.task_id,
        "token": share.token,
        "title": share.title,
        "mode": share.mode or "read_only",
        "revoked": bool(share.revoked),
        "has_password": share.password_hash is not None,
        "created_at": share.created_at,
        "revoked_at": share.revoked_at,
    }
    if include_project and project_id is not None:
        payload["project_id"] = project_id
    return payload


# Small helper used by the WebSocket handler to authenticate a share viewer
# without needing to import internal module state.
def has_active_session(session_token: str) -> bool:
    return session_token in _SHARE_SESSIONS
