"""Write bounded, append-only task operation audit rows in a project DB worker."""

import json
import re
import uuid
from contextvars import ContextVar
from datetime import timedelta
from models.fields import utc_now

import peewee

from models import ProjectAuditEvent
from services.remote_access import get_effective_actor


_ACTION = re.compile(r"[a-z][a-z0-9_.]{1,127}\Z")
_RESULTS = {"succeeded", "denied", "failed"}
_MODES = {"local", "managed"}
_METADATA_KEYS = {
    "source", "step_key", "workflow_run_id", "review_run_id",
    "status", "reason_code", "schedule_id",
    "access_source", "object_name", "workflow_id", "file_name", "file_path", "file_size",
}


def _safe_metadata(metadata: dict | None) -> str:
    values = metadata or {}
    if not isinstance(values, dict) or len(values) > 8:
        raise ValueError("Invalid audit metadata")
    if any(
        key not in _METADATA_KEYS
        or not isinstance(value, (str, int, bool))
        or isinstance(value, str) and len(value) > 256
        for key, value in values.items()
    ):
        raise ValueError("Invalid audit metadata")
    return json.dumps(values, ensure_ascii=False, sort_keys=True)


RETENTION_DAYS = 30
_remote_browser_request = ContextVar("remote_audit_browser_request", default=False)


def remote_audit_source() -> str | None:
    from services.remote_access import get_current_actor, authenticated_remote_dispatch
    actor = get_current_actor()
    if actor and actor.access_source:
        return actor.access_source
    if authenticated_remote_dispatch() is not None or actor and actor.source == "remote":
        return "remote_project"
    return "remote_browser" if _remote_browser_request.get() else None


def record_remote_project_audit(*, project_id: str, action: str, metadata: dict | None = None,
                                task_id: str | None = None, result: str = "succeeded"):
    source = remote_audit_source()
    if source is None:
        return None
    return record_project_audit(project_id=project_id, action=action, result=result,
        task_id=task_id, mode="managed" if source.startswith("gateway") else "local", metadata=metadata)


def prune_project_audit(project_id: str, *, now=None, batch_size: int = 1000) -> int:
    """One bounded delete in the owning project's DB executor; pending rows also expire."""
    if not 1 <= batch_size <= 1000:
        raise ValueError("Invalid audit cleanup batch")
    cutoff = (now or utc_now()) - timedelta(days=RETENTION_DAYS)
    ids = (ProjectAuditEvent.select(ProjectAuditEvent.id)
           .where((ProjectAuditEvent.project_id == project_id) & (ProjectAuditEvent.created_at < cutoff))
           .order_by(ProjectAuditEvent.created_at, ProjectAuditEvent.id).limit(batch_size))
    return ProjectAuditEvent.delete().where(ProjectAuditEvent.id.in_(ids)).execute()


def record_project_audit(
    *, project_id: str, action: str, result: str,
    task_id: str | None = None, mode: str = "local",
    actor_type: str | None = None,
    initiated_by_user_id: str | None = None,
    initiated_by_username: str | None = None,
    metadata: dict | None = None,
    event_id: str | None = None,
) -> ProjectAuditEvent:
    """Persist one event; the caller must use the owning project's DB executor."""
    if not project_id or not _ACTION.fullmatch(action):
        raise ValueError("Invalid audit action or project")
    if result not in _RESULTS or mode not in _MODES:
        raise ValueError("Invalid audit result or mode")
    metadata = dict(metadata or {})
    source = remote_audit_source()
    if source:
        metadata["access_source"] = source
        if task_id and "object_name" not in metadata:
            from models import Task
            task = Task.select(Task.title).where(Task.id == task_id).first()
            if task is not None:
                metadata["object_name"] = task.title[:256]
    metadata_json = _safe_metadata(metadata)
    actor = get_effective_actor()
    if _remote_browser_request.get():
        from services.remote_access import get_current_actor, ActorSnapshot
        actor = get_current_actor() or ActorSnapshot("remote-visitor", "远程访客", "unknown", "未知设备", "remote")
    username = (actor.username or actor.user_name) if actor else None
    kind = actor_type or ("user" if actor else "system")
    if kind not in {"user", "system", "scheduler"}:
        raise ValueError("Invalid audit actor type")
    values = {
        "id": event_id or str(uuid.uuid4()),
        "project_id": project_id,
        "task_id": task_id,
        "action": action,
        "result": result,
        "mode": mode,
        "actor_id": actor.actor_id if actor and kind == "user" else kind,
        "actor_username": username if actor and kind == "user" else kind,
        "actor_name": actor.user_name if actor and kind == "user" else kind,
        "actor_type": kind,
        "device_id": actor.device_id if actor else None,
        "device_name": actor.device_name if actor else None,
        "initiated_by_user_id": initiated_by_user_id or (actor.actor_id if actor else None),
        "initiated_by_username": initiated_by_username or username,
        "metadata_json": metadata_json,
    }
    try:
        return ProjectAuditEvent.create(**values)
    except peewee.IntegrityError:
        if event_id is None:
            raise
        existing = ProjectAuditEvent.get_by_id(event_id)
        if any(getattr(existing, key) != value for key, value in values.items() if key != "id"):
            raise ValueError("Audit event ID already has different content") from None
        return existing


def list_project_audit(
    project_id: str, *, task_id: str | None = None,
    limit: int = 100, before: str | None = None, remote_only: bool = False,
    action: str | None = None, result: str | None = None,
) -> dict:
    """Return one project-local page; the API runs this in its DB executor."""
    if not 1 <= limit <= 200:
        raise ValueError("Invalid audit page limit")
    predicate = ProjectAuditEvent.project_id == project_id
    if remote_only:
        predicate &= ProjectAuditEvent.metadata_json.contains('"access_source"')
    if action:
        predicate &= ProjectAuditEvent.action == action
    if result:
        predicate &= ProjectAuditEvent.result == result
    if task_id:
        predicate &= ProjectAuditEvent.task_id == task_id
    if before:
        cursor = ProjectAuditEvent.get_or_none(
            (ProjectAuditEvent.id == before) & predicate
        )
        if cursor is None:
            raise ValueError("Invalid audit cursor")
        predicate &= (
            (ProjectAuditEvent.created_at < cursor.created_at)
            | ((ProjectAuditEvent.created_at == cursor.created_at)
               & (ProjectAuditEvent.id < cursor.id))
        )
    rows = list(
        ProjectAuditEvent.select().where(predicate)
        .order_by(ProjectAuditEvent.created_at.desc(), ProjectAuditEvent.id.desc())
        .limit(limit + 1)
    )
    page = rows[:limit]
    return {
        "items": [{
            "id": row.id,
            "project_id": row.project_id,
            "task_id": row.task_id,
            "action": row.action,
            "result": row.result,
            "mode": row.mode,
            "actor_id": row.actor_id,
            "actor_username": row.actor_username,
            "actor_name": row.actor_name,
            "actor_type": row.actor_type,
            "device_id": row.device_id,
            "device_name": row.device_name,
            "initiated_by_user_id": row.initiated_by_user_id,
            "initiated_by_username": row.initiated_by_username,
            "metadata": json.loads(row.metadata_json),
            "created_at": row.created_at.isoformat(),
            "upload_status": row.upload_status,
            "upload_error": row.upload_error,
        } for row in page],
        "next_before": page[-1].id if len(rows) > limit else None,
        "retention_days": RETENTION_DAYS,
    }
