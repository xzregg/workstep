from gateway.api.adapters import invoke
from gateway.services.groups_api import create_group as _handle_create_group, list_groups as _handle_list_groups, list_linkable_group_projects as _handle_list_linkable_group_projects, add_group_member as _handle_add_group_member, list_group_members as _handle_list_group_members, remove_group_member as _handle_remove_group_member, link_group_project as _handle_link_group_project, list_group_projects as _handle_list_group_projects, unlink_group_project as _handle_unlink_group_project


from fastapi import APIRouter, Query, Request


from gateway.services.groups_api import GroupInput, MemberInput, GroupProjectInput

from gateway.services.group_member_operations import BulkMemberInput, bulk_members as _handle_bulk_members

router = APIRouter(prefix="/api/groups")

from gateway.services.group_operations import BulkGroupInput, bulk_groups as _bulk_groups, deleted_groups as _deleted_groups


@router.post('/bulk')
async def bulk_groups(request: Request, body: BulkGroupInput):
    return await invoke(_bulk_groups, request=request, body=body)


@router.get('/deleted')
async def deleted_groups(request: Request):
    return await invoke(_deleted_groups, request=request)


@router.post('/{group_id}/members/bulk')
async def bulk_members(request: Request, group_id: str, body: BulkMemberInput):
    return await invoke(_handle_bulk_members, request=request, group_id=group_id, body=body)


@router.post("", status_code=201)
async def create_group(request: Request, body: GroupInput):
    return await invoke(_handle_create_group, request=request, body=body)


@router.get("")
async def list_groups(request: Request):
    return await invoke(_handle_list_groups, request=request)


@router.get("/linkable-projects")
async def list_linkable_group_projects(request: Request,
                                       q: str = Query("", max_length=128),
                                       page: int = Query(1, ge=1),
                                       page_size: int = Query(25, ge=1, le=100)):
    return await invoke(_handle_list_linkable_group_projects, request=request, q=q, page=page, page_size=page_size)


@router.post("/{group_id}/members")
async def add_group_member(request: Request, group_id: str, body: MemberInput):
    return await invoke(_handle_add_group_member, request=request, group_id=group_id, body=body)


@router.get("/{group_id}/members")
async def list_group_members(request: Request, group_id: str):
    return await invoke(_handle_list_group_members, request=request, group_id=group_id)


@router.delete("/{group_id}/members/{user_id}", status_code=204)
async def remove_group_member(request: Request, group_id: str, user_id: str):
    return await invoke(_handle_remove_group_member, request=request, group_id=group_id, user_id=user_id)


@router.post("/{group_id}/projects")
async def link_group_project(request: Request, group_id: str, body: GroupProjectInput):
    return await invoke(_handle_link_group_project, request=request, group_id=group_id, body=body)


@router.get("/{group_id}/projects")
async def list_group_projects(request: Request, group_id: str):
    return await invoke(_handle_list_group_projects, request=request, group_id=group_id)


@router.delete("/{group_id}/projects/{project_id}", status_code=204)
async def unlink_group_project(request: Request, group_id: str, project_id: str):
    return await invoke(_handle_unlink_group_project, request=request, group_id=group_id, project_id=project_id)
