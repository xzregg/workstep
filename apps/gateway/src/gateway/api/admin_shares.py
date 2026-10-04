from gateway.services.admin_shares import list_admin_shares as _handle_list_admin_shares, change_admin_share as _handle_change_admin_share



from fastapi import APIRouter, Query, Request







router = APIRouter(prefix="/api/admin/shares")


@router.get("")
async def list_admin_shares(request: Request,
                            project_id: str | None = None,
                            device_id: str | None = None,
                            status: str | None = Query(None, pattern="^(active|paused|revoked|expired)$"),
                            mode: str | None = Query(None, pattern="^(read_only|interactive)$"),
                            q: str = Query("", max_length=100),
                            offset: int = Query(0, ge=0),
                            limit: int = Query(20, ge=1, le=100)):
    return await _handle_list_admin_shares(request=request, project_id=project_id, device_id=device_id, status=status, mode=mode, q=q, offset=offset, limit=limit)


@router.post("/{share_id}/{action}", status_code=204)
async def change_admin_share(request: Request, share_id: str, action: str):
    return await _handle_change_admin_share(request=request, share_id=share_id, action=action)
