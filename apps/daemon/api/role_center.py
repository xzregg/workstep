"""Host role library management, with every disk operation off the event loop."""
import asyncio
from fastapi import APIRouter, Depends, HTTPException
from api.project_scope import require_catalog_project
from schemas.role_center import RoleWrite, TeamWrite
from services.role_center import RoleConflict, role_center as manager


def authorize():
    # Global assets cannot be modified through a project-scoped remote ticket.
    require_catalog_project("")
    from api.engine import _require_managed_engine_permission
    _require_managed_engine_permission()


router = APIRouter(prefix="/api/role-center", dependencies=[Depends(authorize)])


async def invoke(operation, *args):
    try:
        return await asyncio.to_thread(operation, *args)
    except RoleConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, "角色或专家团不存在") from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(503, "角色中心文件读写失败，请稍后重试") from exc


@router.get("")
async def catalog():
    return await invoke(manager.catalog)


@router.post("/roles", status_code=201)
async def create_role(body: RoleWrite):
    return await invoke(manager.save_role, body)


@router.get("/roles/{role_id}")
async def get_role(role_id: str):
    return await invoke(manager.get_role, role_id)


@router.put("/roles/{role_id}")
async def update_role(role_id: str, body: RoleWrite):
    return await invoke(manager.save_role, body, role_id)


@router.post("/teams", status_code=201)
async def create_team(body: TeamWrite):
    return await invoke(manager.save_team, body)


@router.get("/teams/{team_id}")
async def get_team(team_id: str):
    return await invoke(manager.get_team, team_id)


@router.put("/teams/{team_id}")
async def update_team(team_id: str, body: TeamWrite):
    return await invoke(manager.save_team, body, team_id)
