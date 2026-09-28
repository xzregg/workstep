"""Write bounded, append-only task operation audit rows in a project DB worker."""

import json
import re
import uuid

import peewee

from models import ProjectAuditEvent
from services.remote_access import get_effective_actor


_ACTION = re.compile(r"[a-z][a-z0-9_.]{1,127}\Z")
_RESULTS = {"succeeded", "denied", "failed"}
_MODES = {"local", "managed"}
_METADATA_KEYS = {
    "source", "step_key", "workflow_run_id", "review_run_id",
    "status", "reason_code", "schedule_id",
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
    metadata_json = _safe_metadata(metadata)
    actor = get_effective_actor()
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
    limit: int = 100, before: str | None = None,
) -> dict:
    """Return one project-local page; the API runs this in its DB executor."""
    if not 1 <= limit <= 200:
        raise ValueError("Invalid audit page limit")
    predicate = ProjectAuditEvent.project_id == project_id
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
        } for row in page],
        "next_before": page[-1].id if len(rows) > limit else None,
    }
