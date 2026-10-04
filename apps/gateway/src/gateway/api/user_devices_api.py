from gateway.api.adapters import invoke
from gateway.services.user_devices_api import assigned_devices as _handle_assigned_devices, device_access as _handle_device_access, assign_device_user as _handle_assign_device_user, revoke_device_user as _handle_revoke_device_user

from fastapi import APIRouter, Request


from gateway.services.user_devices_api import AssignUserInput

router = APIRouter(prefix="/api")


@router.get("/devices")
async def assigned_devices(request: Request):
    return await invoke(_handle_assigned_devices, request=request)


@router.get("/devices/{device_id}/access")
async def device_access(request: Request, device_id: str):
    return await invoke(_handle_device_access, request=request, device_id=device_id)


@router.post("/admin/devices/{device_id}/users")
async def assign_device_user(request: Request, device_id: str, body: AssignUserInput):
    return await invoke(_handle_assign_device_user, request=request, device_id=device_id, body=body)


@router.post("/admin/devices/{device_id}/users/{user_id}/revoke", status_code=204)
async def revoke_device_user(request: Request, device_id: str, user_id: str):
    return await invoke(_handle_revoke_device_user, request=request, device_id=device_id, user_id=user_id)
