from gateway.services.skills_api import list_skill_applications as _handle_list_skill_applications, create_skill as _handle_create_skill, list_skills as _handle_list_skills, upload_skill_version as _handle_upload_skill_version, list_skill_versions as _handle_list_skill_versions, approve_skill_version as _handle_approve_skill_version, revoke_skill_version as _handle_revoke_skill_version, grant_group_skill as _handle_grant_group_skill, list_skill_admin_groups as _handle_list_skill_admin_groups, list_skill_admin_group_grants as _handle_list_skill_admin_group_grants, revoke_group_skill as _handle_revoke_group_skill, list_group_skills as _handle_list_group_skills, assign_project_skill as _handle_assign_project_skill, list_project_skills as _handle_list_project_skills, revoke_project_skill as _handle_revoke_project_skill, download_skill_version as _handle_download_skill_version




from fastapi import APIRouter, Request











from gateway.services.skills_api import SkillInput, SkillVersionInput, SkillGrantInput, SkillRevokeInput

router = APIRouter(prefix="/api/admin/skills")


admin_group_router = APIRouter(prefix="/api/admin/groups")


project_skill_router = APIRouter(prefix="/api/groups")


device_skill_router = APIRouter(prefix="/api/device/skills")


@router.get("/applications")
async def list_skill_applications(request: Request):
    return await _handle_list_skill_applications(request=request)


@router.post("", status_code=201)
async def create_skill(request: Request, body: SkillInput):
    return await _handle_create_skill(request=request, body=body)


@router.get("")
async def list_skills(request: Request):
    return await _handle_list_skills(request=request)


@router.post("/{skill_id}/versions", status_code=201)
async def upload_skill_version(request: Request, skill_id: str, body: SkillVersionInput):
    return await _handle_upload_skill_version(request=request, skill_id=skill_id, body=body)


@router.get("/{skill_id}/versions")
async def list_skill_versions(request: Request, skill_id: str):
    return await _handle_list_skill_versions(request=request, skill_id=skill_id)


@router.post("/{skill_id}/versions/{version_id}/approve")
async def approve_skill_version(request: Request, skill_id: str, version_id: str):
    return await _handle_approve_skill_version(request=request, skill_id=skill_id, version_id=version_id)


@router.post("/{skill_id}/versions/{version_id}/revoke")
async def revoke_skill_version(request: Request, skill_id: str,
                               version_id: str, body: SkillRevokeInput):
    return await _handle_revoke_skill_version(request=request, skill_id=skill_id, version_id=version_id, body=body)


@admin_group_router.post("/{group_id}/skills")
async def grant_group_skill(request: Request, group_id: str, body: SkillGrantInput):
    return await _handle_grant_group_skill(request=request, group_id=group_id, body=body)


@admin_group_router.get("")
async def list_skill_admin_groups(request: Request):
    return await _handle_list_skill_admin_groups(request=request)


@admin_group_router.get("/{group_id}/skills")
async def list_skill_admin_group_grants(request: Request, group_id: str):
    return await _handle_list_skill_admin_group_grants(request=request, group_id=group_id)


@admin_group_router.delete("/{group_id}/skills/{skill_id}", status_code=204)
async def revoke_group_skill(request: Request, group_id: str, skill_id: str):
    return await _handle_revoke_group_skill(request=request, group_id=group_id, skill_id=skill_id)


@project_skill_router.get("/{group_id}/skills")
async def list_group_skills(request: Request, group_id: str):
    return await _handle_list_group_skills(request=request, group_id=group_id)


@project_skill_router.post("/{group_id}/projects/{project_id}/skills")
async def assign_project_skill(request: Request, group_id: str,
                               project_id: str, body: SkillGrantInput):
    return await _handle_assign_project_skill(request=request, group_id=group_id, project_id=project_id, body=body)


@project_skill_router.get("/{group_id}/projects/{project_id}/skills")
async def list_project_skills(request: Request, group_id: str, project_id: str):
    return await _handle_list_project_skills(request=request, group_id=group_id, project_id=project_id)


@project_skill_router.delete("/{group_id}/projects/{project_id}/skills/{skill_id}",
                             status_code=204)
async def revoke_project_skill(request: Request, group_id: str,
                               project_id: str, skill_id: str):
    return await _handle_revoke_project_skill(request=request, group_id=group_id, project_id=project_id, skill_id=skill_id)


@device_skill_router.get("/{version_id}")
async def download_skill_version(request: Request, version_id: str):
    return await _handle_download_skill_version(request=request, version_id=version_id)
