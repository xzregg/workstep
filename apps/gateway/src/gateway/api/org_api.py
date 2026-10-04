from gateway.api.adapters import invoke
from gateway.services.org_api import list_departments as _handle_list_departments, list_department_members as _handle_list_department_members
from typing import Literal

from fastapi import APIRouter, Query, Request


router = APIRouter(prefix='/api/admin/org')


@router.get('/departments')
async def list_departments(request: Request, source_id: str | None = None,
                           q: str = Query('', max_length=128),
                           roots_only: bool = False, parent_id: str | None = None,
                           status: Literal['active', 'deleted', 'all'] = 'active',
                           sort: Literal['display_name', 'external_id'] = 'display_name',
                           direction: Literal['asc', 'desc'] = 'asc',
                           page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100)):
    return await invoke(_handle_list_departments, request=request, source_id=source_id, q=q, roots_only=roots_only, parent_id=parent_id, status=status, sort=sort, direction=direction, page=page, page_size=page_size)


@router.get('/departments/{department_id}/members')
async def list_department_members(request: Request, department_id: str,
                                  q: str = Query('', max_length=128),
                                  sort: Literal['display_name', 'username'] = 'display_name',
                                  direction: Literal['asc', 'desc'] = 'asc',
                                  page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100)):
    return await invoke(_handle_list_department_members, request=request, department_id=department_id, q=q, sort=sort, direction=direction, page=page, page_size=page_size)
