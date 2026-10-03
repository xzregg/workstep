from gateway.services.desktop_authorization_api import gateway_key as _handle_gateway_key, authorize_desktop as _handle_authorize_desktop, redeem_desktop_code as _handle_redeem_desktop_code, approve_device as _handle_approve_device, list_devices as _handle_list_devices, disable_device as _handle_disable_device, revoke_device as _handle_revoke_device

from typing import Literal


from fastapi import APIRouter, Query, Request










from gateway.services.desktop_authorization_api import DesktopAuthorizeInput, DesktopTokenInput

router = APIRouter(prefix="/api")


@router.get("/platform/gateway-key")
async def gateway_key(request: Request):
    return await _handle_gateway_key(request=request)


@router.post("/desktop/authorize")
async def authorize_desktop(request: Request, body: DesktopAuthorizeInput):
    return await _handle_authorize_desktop(request=request, body=body)


@router.post("/desktop/token")
async def redeem_desktop_code(request: Request, body: DesktopTokenInput):
    return await _handle_redeem_desktop_code(request=request, body=body)


@router.post("/admin/devices/{device_id}/approve", status_code=204)
async def approve_device(request: Request, device_id: str):
    return await _handle_approve_device(request=request, device_id=device_id)


@router.get("/admin/devices")
async def list_devices(request: Request, status: Literal["pending", "active", "disabled", "revoked"] | None = None,
                       q: str = Query(default='', max_length=128),
                       sort: Literal['created_at', 'name', 'status'] = 'created_at',
                       direction: Literal['asc', 'desc'] = 'desc',
                       page: int = Query(default=1, ge=1), page_size: int = Query(default=25, ge=1, le=100)):
    return await _handle_list_devices(request=request, status=status, q=q, sort=sort, direction=direction, page=page, page_size=page_size)


@router.post("/admin/devices/{device_id}/disable", status_code=204)
async def disable_device(request: Request, device_id: str):
    return await _handle_disable_device(request=request, device_id=device_id)


@router.post("/admin/devices/{device_id}/revoke", status_code=204)
async def revoke_device(request: Request, device_id: str):
    return await _handle_revoke_device(request=request, device_id=device_id)
