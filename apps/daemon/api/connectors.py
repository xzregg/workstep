"""Host-managed definitions and project-scoped session connector selection."""
import asyncio
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from api.custom_engine import authorize
from api.project_scope import require_catalog_project
from services.connectors.store import connector_store
from services.connectors.discovery import scan_local
from services.connectors.runtime import engine_supports_mcp

router = APIRouter(prefix='/api/connectors', tags=['connectors'])


async def operation(function, *args):
    try:
        return await asyncio.to_thread(function, *args)
    except PermissionError as exc:
        raise HTTPException(403, '连接器不在当前项目可用范围内') from exc
    except (ValueError, OSError):
        raise HTTPException(400, '配置无效、已变化或无法读取，请检查后重试') from None


@router.get('', dependencies=[Depends(authorize)])
async def catalog():
    return {'connectors': await operation(connector_store.list)}


@router.post('', dependencies=[Depends(authorize)])
@router.put('', dependencies=[Depends(authorize)])
async def save(value: dict):
    return await operation(connector_store.save, value)


@router.delete('/{identifier}', dependencies=[Depends(authorize)])
async def delete(identifier: str):
    await operation(connector_store.delete, identifier)
    return {'ok': True}


@router.post('/scan', dependencies=[Depends(authorize)])
async def scan():
    return {'items': await operation(scan_local)}


class DiagnosticRequest(BaseModel):
    definition: dict
    tool_name: str | None = Field(default=None, min_length=1, max_length=256)
    arguments: dict = Field(default_factory=dict)


@router.post('/test', dependencies=[Depends(authorize)])
async def diagnose(value: DiagnosticRequest):
    from services.connectors.transport import diagnose as run_diagnostic
    item = await operation(connector_store.preview, value.definition)
    return await run_diagnostic(item, tool_name=value.tool_name, arguments=value.arguments)


@router.post('/{identifier}/test', dependencies=[Depends(authorize)])
async def test(identifier: str):
    from services.connectors.transport import probe
    item = await operation(connector_store.resolve, identifier)
    if item is None:
        raise HTTPException(404, '连接器不存在')
    return await probe(item)


def project_access(project_id, write=False):
    require_catalog_project(project_id)
    from services.remote_access import get_current_actor
    actor = get_current_actor()
    if write and actor and actor.project_id is not None and actor.access_level != 'edit':
        raise HTTPException(403, '需要项目编辑权限')


@router.get('/available')
async def available(project_id: str = Query(min_length=1), session_id: str = '', engine_id: str = ''):
    project_access(project_id)
    items = await operation(connector_store.list)
    selected = await operation(connector_store.selected, project_id, session_id)
    compatible = not engine_id or await operation(engine_supports_mcp, engine_id)
    # Never expose commands, source paths or environment names in project workspaces.
    return {'connectors': [{'id': i['id'], 'name': i['name'], 'description': i['description'],
                            'kind': i['kind'], 'selected': i['id'] in {s['id'] for s in selected},
                            'available': compatible}
                           for i in items if connector_store.allowed(i, project_id)]}


class Selection(BaseModel):
    project_id: str = Field(min_length=1, max_length=128)
    session_id: str = Field(min_length=1, max_length=256)
    connector_ids: list[str] = Field(default_factory=list, max_length=100)


@router.put('/selection')
async def select(value: Selection):
    project_access(value.project_id, write=True)
    await operation(connector_store.select, value.project_id, value.session_id, value.connector_ids)
    return {'ok': True}
