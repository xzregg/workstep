"""Gateway share management from the local device workbench."""
import asyncio
from typing import Literal
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from api.workspace_access import require_workspace_access, require_same_origin

router = APIRouter(prefix='/api/gateway-task-shares')


class CreateInput(BaseModel):
    project_id: str = Field(min_length=1, max_length=128)
    task_id: str = Field(min_length=1, max_length=128)
    require_login: bool = False
    password: str | None = Field(default=None, min_length=4, max_length=200)
    title: str = Field(default='', max_length=256)
    mode: Literal['read_only', 'interactive'] = 'read_only'
    expires_at: str | None = None


async def _call(request: Request, project_id: str, action: str, payload: dict):
    gateway = getattr(request.app.state, 'gateway_client', None)
    if gateway is None or gateway.managed_config is None or gateway.control_client is None:
        raise HTTPException(503, 'Gateway connection unavailable, please connect to the gateway and retry.')
    await require_workspace_access(request, 'owner_session', detail='Please log in with the gateway account of the current device to manage sharing.')
    if request.method != 'GET':
        require_same_origin(request, detail='Share management requires same-origin requests')
    try:
        return await gateway.control_client.manage_task_share(gateway.device_id, project_id, action, payload)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except (ValueError, KeyError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except (ConnectionError, asyncio.TimeoutError) as exc:
        raise HTTPException(503, 'Gateway connection unavailable, please retry.') from exc


@router.get('')
async def listing(request: Request, project_id: str, task_id: str):
    return await _call(request, project_id, 'list', {'task_id':task_id})


@router.post('')
async def create(request: Request, body: CreateInput):
    return await _call(request, body.project_id, 'create', body.model_dump(exclude={'project_id'}))


@router.post('/{share_id}/revoke')
async def revoke(request: Request, share_id: str, project_id: str):
    await _call(request, project_id, 'revoke', {'share_id':share_id})
    return {'ok':True}
