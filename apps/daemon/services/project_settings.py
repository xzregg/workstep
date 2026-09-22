"""Project-scoped settings persistence on top of the ``project_settings`` table.

Existing keys (chat system prompt, quick buttons) are read/written by the
chat session module; this module owns the ``concurrency`` key and the
``sync_project_config``/``sync_all_project_configs`` helpers that keep the
in-memory ``ConcurrencyGate`` aligned with persisted values.

All database work units are synchronous and must run through
``project_manager.run_db`` (Peewee async-isolation rule).
"""

from __future__ import annotations

import json
import logging
import uuid

from models.chat_session import ProjectSetting
from models.fields import utc_now

logger = logging.getLogger(__name__)

CONCURRENCY_KEY = "concurrency"


# ── persistence (sync, run inside project_manager.run_db) ─────────────

def get_project_setting(project_id: str, key: str):
    """Return the ProjectSetting row for (project_id, key) or None."""
    return ProjectSetting.get_or_none(
        (ProjectSetting.project_id == project_id) & (ProjectSetting.key == key)
    )


def get_concurrency_sync(project_id: str) -> dict:
    """Read the project's concurrency override (all-null when unset)."""
    row = get_project_setting(project_id, CONCURRENCY_KEY)
    raw = {}
    if row is not None and row.value_json:
        try:
            parsed = json.loads(row.value_json)
            if isinstance(parsed, dict):
                raw = parsed
        except json.JSONDecodeError:
            logger.warning(
                "Ignoring malformed concurrency setting for project %s",
                project_id,
            )
    return {
        "max_tasks": raw.get("max_tasks"),
        "max_chats": raw.get("max_chats"),
        "schedule_exempt": raw.get("schedule_exempt"),
    }


def set_concurrency_sync(
    project_id: str,
    *,
    max_tasks: int | None,
    max_chats: int | None,
    schedule_exempt: bool | None,
) -> dict:
    """Persist a project concurrency override; ``None`` values follow global.

    An override with all three fields ``None`` removes the stored row.
    """
    values = {
        "max_tasks": max_tasks,
        "max_chats": max_chats,
        "schedule_exempt": schedule_exempt,
    }
    if all(value is None for value in values.values()):
        row = get_project_setting(project_id, CONCURRENCY_KEY)
        if row is not None:
            row.delete_instance()
        return {"max_tasks": None, "max_chats": None, "schedule_exempt": None}

    row = get_project_setting(project_id, CONCURRENCY_KEY)
    if row is None:
        # ProjectSetting has a non-autoincrement text PK: ``save()`` would
        # issue an UPDATE and silently match zero rows, so insert explicitly.
        row = ProjectSetting.create(
            id=str(uuid.uuid4()),
            project_id=project_id,
            key=CONCURRENCY_KEY,
            value_json=json.dumps(values, ensure_ascii=False),
            updated_at=utc_now(),
        )
    else:
        row.value_json = json.dumps(values, ensure_ascii=False)
        row.updated_at = utc_now()
        row.save()
    return dict(values)


# ── gate synchronization ──────────────────────────────────────────────

def sync_project_config(project_id: str) -> None:
    """Push one project's persisted override into the in-memory gate.

    Callers must run this while the project DB context is active (inside
    ``project_manager.run_db`` or a project activation); it reads the
    ``project_settings`` table synchronously.
    """
    from services.concurrency import concurrency_gate

    config = get_concurrency_sync(project_id)
    concurrency_gate.set_project_config(
        project_id,
        config if any(value is not None for value in config.values()) else None,
    )


async def sync_all_project_configs(project_manager) -> None:
    """Push every registered project's override into the gate (startup)."""
    from services.concurrency import concurrency_gate

    for project in project_manager.iter_projects():
        try:
            config = await project_manager.run_db(
                project.id,
                lambda _project, pid=project.id: get_concurrency_sync(pid),
            )
            concurrency_gate.set_project_config(
                project.id,
                config if any(value is not None for value in config.values()) else None,
            )
        except Exception:
            logger.exception(
                "Failed to sync concurrency config for project %s", project.id
            )


def effective_concurrency(project_id: str, global_config: dict | None = None) -> dict:
    """Project explicit value > global default > unlimited.

    ``global_config`` is the dict returned by
    ``config_store.get_concurrency_config()``; when omitted it is read live.
    """
    from services.config import config_store

    if global_config is None:
        global_config = config_store.get_concurrency_config()
    override = get_concurrency_sync(project_id)
    return {
        "max_tasks": (
            override["max_tasks"]
            if override["max_tasks"] is not None
            else global_config["max_tasks"]
        ),
        "max_chats": (
            override["max_chats"]
            if override["max_chats"] is not None
            else global_config["max_chats"]
        ),
        "schedule_exempt": (
            override["schedule_exempt"]
            if override["schedule_exempt"] is not None
            else global_config["schedule_exempt"]
        ),
    }
