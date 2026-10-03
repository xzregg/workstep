from gateway.services.device_groups_api import list_groups as _handle_list_groups, create_group as _handle_create_group, add_member as _handle_add_member, remove_member as _handle_remove_member, set_department as _handle_set_department


from fastapi import APIRouter, Request








from gateway.services.device_groups_api import GroupInput, DepartmentInput

router = APIRouter(prefix="/api/admin")


@router.get("/device-groups")
async def list_groups(request: Request):
    return await _handle_list_groups(request=request)


@router.post("/device-groups", status_code=201)
async def create_group(request: Request, body: GroupInput):
    return await _handle_create_group(request=request, body=body)


@router.put("/device-groups/{group_id}/devices/{device_id}", status_code=204)
async def add_member(request: Request, group_id: str, device_id: str):
    return await _handle_add_member(request=request, group_id=group_id, device_id=device_id)


@router.delete("/device-groups/{group_id}/devices/{device_id}", status_code=204)
async def remove_member(request: Request, group_id: str, device_id: str):
    return await _handle_remove_member(request=request, group_id=group_id, device_id=device_id)


@router.put("/devices/{device_id}/department", status_code=204)
async def set_department(request: Request, device_id: str, body: DepartmentInput):
    return await _handle_set_department(request=request, device_id=device_id, body=body)
