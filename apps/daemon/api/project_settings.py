"""Project settings API — the unified 项目配置 popover data source.

Serves the settings aggregated for the project-config panel (常规 / 对话助手 /
并发限制) plus the dedicated concurrency override endpoints. The 分享 tab
reuses the existing remote-project API and its dialog component.
"""

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from services.config import config_store
from services.project_settings import (
    get_concurrency_sync,
    set_concurrency_sync,
)

router = APIRouter(prefix="/api/projects")


async def _run_db(project_id: str, operation):
    from main import project_manager

    return await project_manager.run_db(
        project_id,
        lambda _project: operation(),
    )


def _require_project(project_id: str):
    from main import project_manager

    project = project_manager.get_project_by_id(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")
    return project


class ProjectConcurrencyRequest(BaseModel):
    max_tasks: int | None = Field(default=None, ge=0, le=1000)
    max_chats: int | None = Field(default=None, ge=0, le=1000)
    schedule_exempt: bool | None = None


@router.get("/{project_id}/settings/concurrency")
async def get_project_concurrency(project_id: str):
    """Return the project's concurrency override plus effective/global values.

    ``null`` override fields mean "follow global"; the effective values are
    what the gate actually enforces right now.
    """
    _require_project(project_id)
    global_config = config_store.get_concurrency_config()
    project_override = await _run_db(
        project_id, lambda: get_concurrency_sync(project_id)
    )

    def pick(project_value, global_value):
        return project_value if project_value is not None else global_value

    return {
        "global": global_config,
        "project": project_override,
        "effective": {
            "max_tasks": pick(
                project_override["max_tasks"], global_config["max_tasks"]
            ),
            "max_chats": pick(
                project_override["max_chats"], global_config["max_chats"]
            ),
            "schedule_exempt": pick(
                project_override["schedule_exempt"], global_config["schedule_exempt"]
            ),
        },
    }


@router.put("/{project_id}/settings/concurrency")
async def set_project_concurrency(
    project_id: str, req: ProjectConcurrencyRequest
):
    """Save a project's concurrency override (None = follow global)."""
    from services.concurrency import concurrency_gate

    _require_project(project_id)
    saved, override = await _run_db(
        project_id,
        lambda: (
            set_concurrency_sync(
                project_id,
                max_tasks=req.max_tasks,
                max_chats=req.max_chats,
                schedule_exempt=req.schedule_exempt,
            ),
            get_concurrency_sync(project_id),
        ),
    )
    concurrency_gate.set_project_config(
        project_id,
        override if any(value is not None for value in override.values()) else None,
    )
    return {"saved": True, "project": saved}


@router.get("/{project_id}/settings")
async def get_project_settings(
    project_id: str, with_share: bool = Query(False)
):
    """Aggregate the project-config panel data (常规 + 对话助手 + 并发限制)."""
    project = _require_project(project_id)

    def load_chat_settings():
        from agent_assistants.chat_session import ChatSessionModule

        module = ChatSessionModule.get_current() if hasattr(
            ChatSessionModule, "get_current"
        ) else None
        if module is None:
            from main import chat_session_module

            module = chat_session_module
        if module is None:
            return {"chat_system_prompt": "", "quick_buttons": []}
        return {
            "chat_system_prompt": module.get_system_prompt(project_id),
            "quick_buttons": module.get_quick_buttons(project_id),
        }

    chat = await _run_db(project_id, load_chat_settings)
    override = await _run_db(project_id, lambda: get_concurrency_sync(project_id))
    global_config = config_store.get_concurrency_config()

    def pick(project_value, global_value):
        return project_value if project_value is not None else global_value

    result = {
        "name": project.name,
        "path": str(project.path),
        "chat_system_prompt": chat["chat_system_prompt"],
        "quick_buttons": chat["quick_buttons"],
        "concurrency": {
            "global": global_config,
            "project": override,
            "effective": {
                "max_tasks": pick(
                    override["max_tasks"], global_config["max_tasks"]
                ),
                "max_chats": pick(
                    override["max_chats"], global_config["max_chats"]
                ),
                "schedule_exempt": pick(
                    override["schedule_exempt"], global_config["schedule_exempt"]
                ),
            },
        },
    }
    if with_share:
        result["share"] = _load_share_settings(project_id)
    return result


def _load_share_settings(project_id: str) -> dict:
    """Current share status for the project (read-only summary).

    The share tab itself reuses the existing remote-project APIs; this just
    summarizes invites + authorized devices so the panel can render a badge.
    """
    try:
        from services.remote_project import RemoteAccessService

        service = RemoteAccessService(config_store)
        devices = service.list_devices(project_id)
        raw = config_store.get("remote_access", {})
        invites = [
            item
            for item in list(raw.get("invites") or [])
            if item.get("project_id") == project_id and not item.get("used")
        ]
        return {
            "active_invites": len(invites),
            "devices": devices,
        }
    except Exception:
        return {"active_invites": 0, "devices": []}
