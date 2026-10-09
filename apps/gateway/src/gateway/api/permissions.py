from typing import Literal

from fastapi import APIRouter, Query, Request
from gateway.api.adapters import invoke
from gateway.services.permissions import (PermissionInput, permission_catalog, list_permissions,
                                          set_permission, revoke_permission, permission_subjects, permission_resources)

router = APIRouter(prefix="/api/admin/permissions")


@router.get("/catalog")
async def catalog(request: Request):
    return await invoke(permission_catalog, request=request)


@router.get("")
async def listing(request: Request, subject_type: Literal["user", "group"] | None = None,
                  subject_id: str | None = None):
    return await invoke(list_permissions, request=request, subject_type=subject_type, subject_id=subject_id)


@router.get("/subjects")
async def subjects(request: Request, subject_type: Literal["user", "group"] = "user", q: str = "",
                   page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100)):
    return await invoke(permission_subjects, request=request, subject_type=subject_type, q=q, page=page, page_size=page_size)


@router.get("/resources")
async def resources(request: Request, scope_type: str, q: str = "",
                    page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100)):
    return await invoke(permission_resources, request=request, scope_type=scope_type, q=q, page=page, page_size=page_size)


@router.post("")
async def assign(request: Request, body: PermissionInput):
    return await invoke(set_permission, request=request, body=body)


@router.delete("/{assignment_id}", status_code=204)
async def revoke(request: Request, assignment_id: str):
    return await invoke(revoke_permission, request=request, assignment_id=assignment_id)
