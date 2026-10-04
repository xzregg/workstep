from gateway.api.adapters import invoke
from gateway.services.audit_ledger import query_audit as _handle_query_audit


from datetime import datetime


from fastapi import APIRouter, Query, Request


router = APIRouter(prefix="/api/admin/audit")


@router.get("")
async def query_audit(
    request: Request,
    project_id: str | None = Query(default=None, max_length=64),
    device_id: str | None = Query(default=None, max_length=64),
    action: str | None = Query(default=None, max_length=128),
    user_id: str | None = Query(default=None, max_length=64),
    result: str | None = Query(default=None, max_length=16),
    q: str | None = Query(default=None, max_length=128),
    from_time: datetime | None = None,
    to_time: datetime | None = None,
    limit: int = Query(default=100, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    return await invoke(_handle_query_audit, request=request, project_id=project_id, device_id=device_id, action=action, user_id=user_id, result=result, q=q, from_time=from_time, to_time=to_time, limit=limit, offset=offset)
