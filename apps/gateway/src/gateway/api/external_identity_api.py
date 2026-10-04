from gateway.api.adapters import invoke
from gateway.services.external_identity_api import create_source as _handle_create_source, list_sources as _handle_list_sources, sync_directory as _handle_sync_directory, reconcile_directory as _handle_reconcile_directory, apply_directory_event as _handle_apply_directory_event, disable_source as _handle_disable_source, external_start as _handle_external_start, identity_sources as _handle_identity_sources, external_bind_start as _handle_external_bind_start, external_callback as _handle_external_callback


from typing import Literal


from fastapi import APIRouter, Query, Request, Response


from gateway.services.external_identity_api import SourceInput, DirectorySnapshot, PersonEvent, ExternalStartInput

router = APIRouter(prefix="/api")


@router.post("/admin/identity-sources", status_code=201)
async def create_source(request: Request, body: SourceInput):
    return await invoke(_handle_create_source, request=request, body=body)


@router.get("/admin/identity-sources")
async def list_sources(request: Request, q: str = Query('', max_length=128),
                       provider: Literal['dingtalk', 'wecom'] | None = None,
                       status: Literal['enabled', 'disabled'] | None = None,
                       sort: Literal['created_at', 'tenant_id'] = 'created_at',
                       direction: Literal['asc', 'desc'] = 'desc',
                       page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100)):
    return await invoke(_handle_list_sources, request=request, q=q, provider=provider, status=status, sort=sort, direction=direction, page=page, page_size=page_size)


@router.post("/admin/identity-sources/{source_id}/sync")
async def sync_directory(request: Request, source_id: str, body: DirectorySnapshot):
    return await invoke(_handle_sync_directory, request=request, source_id=source_id, body=body)


@router.post("/admin/identity-sources/{source_id}/reconcile")
async def reconcile_directory(request: Request, source_id: str):
    return await invoke(_handle_reconcile_directory, request=request, source_id=source_id)


@router.post("/admin/identity-sources/{source_id}/events")
async def apply_directory_event(request: Request, source_id: str, body: PersonEvent):
    return await invoke(_handle_apply_directory_event, request=request, source_id=source_id, body=body)


@router.post("/admin/identity-sources/{source_id}/disable", status_code=204)
async def disable_source(request: Request, source_id: str):
    return await invoke(_handle_disable_source, request=request, source_id=source_id)


@router.post("/auth/external/{source_id}/start")
async def external_start(request: Request, source_id: str, body: ExternalStartInput | None = None):
    return await invoke(_handle_external_start, request=request, source_id=source_id, body=body)


@router.get("/auth/identity-sources")
async def identity_sources(request: Request):
    return await invoke(_handle_identity_sources, request=request)


@router.post("/auth/external/{source_id}/bind/start")
async def external_bind_start(request: Request, source_id: str):
    return await invoke(_handle_external_bind_start, request=request, source_id=source_id)


@router.get("/auth/external/{source_id}/callback")
async def external_callback(request: Request, response: Response, source_id: str,
                            state: str, code: str | None = None, authCode: str | None = None,
                            error: str | None = None):
    return await invoke(_handle_external_callback, request=request, response=response, source_id=source_id, state=state, code=code, authCode=authCode, error=error)


@router.put('/admin/identity-sources/{source_id}')
async def update_source(request: Request, source_id: str, body: SourceInput):
    from gateway.services.external_identity_api import update_source as handle
    return await invoke(handle, request=request, source_id=source_id, body=body)


@router.get('/admin/user-groups/tree')
async def user_group_tree(request: Request):
    from gateway.services.organization_settings import user_group_tree as handle
    return await invoke(handle, request=request)
