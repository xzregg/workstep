from gateway.api.adapters import invoke
from gateway.services.project_access_api import set_project_grant as _handle_set_project_grant, revoke_project_grant as _handle_revoke_project_grant, project_access as _handle_project_access, list_accessible_projects as _handle_list_accessible_projects, list_admin_projects as _handle_list_admin_projects, list_project_grant_subjects as _handle_list_project_grant_subjects, list_publishable_projects as _handle_list_publishable_projects, admin_publish_project as _handle_admin_publish_project, admin_unpublish_project as _handle_admin_unpublish_project, list_project_grants as _handle_list_project_grants

from typing import Literal


from fastapi import APIRouter, Path, Query, Request


from gateway.services.project_access_api import ProjectGrantInput

router = APIRouter(prefix="/api")


@router.post("/admin/projects/{project_id}/grants")
async def set_project_grant(request: Request, project_id: str,
                            body: ProjectGrantInput):
    return await invoke(_handle_set_project_grant, request=request, project_id=project_id, body=body)


@router.delete("/admin/projects/{project_id}/grants/{subject_type}/{subject_id}",
               status_code=204)
async def revoke_project_grant(request: Request, project_id: str,
                               subject_type: Literal["user", "group"],
                               subject_id: str):
    return await invoke(_handle_revoke_project_grant, request=request, project_id=project_id, subject_type=subject_type, subject_id=subject_id)


@router.get("/projects/{project_id}/access")
async def project_access(request: Request, project_id: str):
    return await invoke(_handle_project_access, request=request, project_id=project_id)


@router.get("/projects")
async def list_accessible_projects(request: Request):
    return await invoke(_handle_list_accessible_projects, request=request)


@router.get('/admin/projects')
async def list_admin_projects(request: Request, q: str = Query('', max_length=128),
                              sort: Literal['name', 'published_at'] = 'name',
                              direction: Literal['asc', 'desc'] = 'asc',
                              page: int = Query(1, ge=1),
                              page_size: int = Query(25, ge=1, le=100)):
    return await invoke(_handle_list_admin_projects, request=request, q=q, sort=sort, direction=direction, page=page, page_size=page_size)


@router.get('/admin/project-grant-subjects')
async def list_project_grant_subjects(request: Request,
                                      subject_type: Literal['user', 'group'],
                                      q: str = Query('', max_length=128),
                                      page: int = Query(1, ge=1),
                                      page_size: int = Query(25, ge=1, le=100)):
    return await invoke(_handle_list_project_grant_subjects, request=request, subject_type=subject_type, q=q, page=page, page_size=page_size)


@router.get('/admin/devices/{device_id}/publishable-projects')
async def list_publishable_projects(request: Request, device_id: str,
                                    q: str = Query('', max_length=128),
                                    page: int = Query(1, ge=1),
                                    page_size: int = Query(25, ge=1, le=100)):
    return await invoke(_handle_list_publishable_projects, request=request, device_id=device_id, q=q, page=page, page_size=page_size)


@router.post('/admin/devices/{device_id}/projects/{host_project_id}/publish')
async def admin_publish_project(request: Request, device_id: str,
                                host_project_id: str = Path(min_length=1, max_length=128)):
    return await invoke(_handle_admin_publish_project, request=request, device_id=device_id, host_project_id=host_project_id)


@router.post('/admin/projects/{project_id}/unpublish')
async def admin_unpublish_project(request: Request, project_id: str):
    return await invoke(_handle_admin_unpublish_project, request=request, project_id=project_id)


@router.get("/admin/projects/{project_id}/grants")
async def list_project_grants(request: Request, project_id: str):
    return await invoke(_handle_list_project_grants, request=request, project_id=project_id)
