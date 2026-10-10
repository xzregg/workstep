"""Task share management inside an authenticated Gateway workspace."""
from fastapi import APIRouter, Request, Query
from gateway.api.adapters import invoke
from gateway.services import remote_task_shares as service
from gateway.services.platform_shares import CreateShareInput

router = APIRouter(prefix="/api/remote/task-shares")

@router.post("", status_code=201)
async def create(request: Request, body: CreateShareInput):
    return await invoke(service.create, request=request, body=body)

@router.get("")
async def listing(request: Request,
                  project_id: str = Query(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"),
                  task_id: str = Query(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")):
    return await invoke(service.listing, request=request, project_id=project_id, task_id=task_id)

@router.post("/{share_id}/revoke", status_code=204)
async def revoke(request: Request, share_id: str):
    return await invoke(service.revoke, request=request, share_id=share_id)
