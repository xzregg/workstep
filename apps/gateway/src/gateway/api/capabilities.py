from gateway.api.adapters import invoke
from gateway.services.capabilities import list_user_project_capabilities as _handle_list_user_project_capabilities, list_group_project_capabilities as _handle_list_group_project_capabilities, set_group_project_capability as _handle_set_group_project_capability, revoke_group_project_capability as _handle_revoke_group_project_capability, set_capability as _handle_set_capability, revoke_capability as _handle_revoke_capability


from fastapi import APIRouter, Request


from gateway.services.capabilities import CapabilityTargetInput, CapabilityInput, GroupProjectCapabilityInput

router = APIRouter(prefix="/api")


@router.get('/admin/projects/{project_id}/task-create-users')
async def list_user_project_capabilities(request: Request, project_id: str):
    return await invoke(_handle_list_user_project_capabilities, request=request, project_id=project_id)


@router.get('/admin/projects/{project_id}/task-create-groups')
async def list_group_project_capabilities(request: Request, project_id: str):
    return await invoke(_handle_list_group_project_capabilities, request=request, project_id=project_id)


@router.post('/admin/projects/{project_id}/task-create-groups/{group_id}')
async def set_group_project_capability(request: Request, project_id: str,
                                       group_id: str, body: GroupProjectCapabilityInput):
    return await invoke(_handle_set_group_project_capability, request=request, project_id=project_id, group_id=group_id, body=body)


@router.delete('/admin/projects/{project_id}/task-create-groups/{group_id}', status_code=204)
async def revoke_group_project_capability(request: Request, project_id: str, group_id: str):
    return await invoke(_handle_revoke_group_project_capability, request=request, project_id=project_id, group_id=group_id)


@router.post("/admin/capabilities/{user_id}")
async def set_capability(request: Request, user_id: str, body: CapabilityInput):
    return await invoke(_handle_set_capability, request=request, user_id=user_id, body=body)


@router.post("/admin/capabilities/{user_id}/revoke", status_code=204)
async def revoke_capability(request: Request, user_id: str, body: CapabilityTargetInput):
    return await invoke(_handle_revoke_capability, request=request, user_id=user_id, body=body)
