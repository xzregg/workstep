from gateway.services.providers_api import list_assignment_catalog as _handle_list_assignment_catalog, list_platform_providers as _handle_list_platform_providers, list_provider_applications as _handle_list_provider_applications, test_platform_provider as _handle_test_platform_provider, list_provider_test_targets as _handle_list_provider_test_targets, create_platform_provider as _handle_create_platform_provider, update_platform_provider as _handle_update_platform_provider, list_platform_provider_assignments as _handle_list_platform_provider_assignments, assign_platform_provider as _handle_assign_platform_provider, set_default_platform_provider as _handle_set_default_platform_provider, revoke_platform_provider_assignment as _handle_revoke_platform_provider_assignment, disable_platform_provider as _handle_disable_platform_provider


from typing import Literal



from fastapi import APIRouter, Query, Request









from gateway.services.providers_api import ProviderInput, ProviderUpdateInput, ProviderAssignInput, ProviderDefaultInput, ProviderTestInput

router = APIRouter(prefix="/api/admin/providers")


@router.get("/assignment-catalog")
async def list_assignment_catalog(request: Request):
    return await _handle_list_assignment_catalog(request=request)


@router.get("")
async def list_platform_providers(request: Request,
                                  q: str = Query("", max_length=128),
                                  enabled: bool | None = None,
                                  sort: Literal["name", "created_at"] = "name",
                                  direction: Literal["asc", "desc"] = "asc",
                                  page: int = Query(1, ge=1),
                                  page_size: int = Query(25, ge=1, le=100)):
    return await _handle_list_platform_providers(request=request, q=q, enabled=enabled, sort=sort, direction=direction, page=page, page_size=page_size)


@router.get("/applications")
async def list_provider_applications(request: Request,
                                     q: str = Query("", max_length=128),
                                     page: int = Query(1, ge=1),
                                     page_size: int = Query(25, ge=1, le=100)):
    return await _handle_list_provider_applications(request=request, q=q, page=page, page_size=page_size)


@router.post("/{provider_id}/test")
async def test_platform_provider(request: Request, provider_id: str,
                                 body: ProviderTestInput):
    return await _handle_test_platform_provider(request=request, provider_id=provider_id, body=body)


@router.get("/{provider_id}/test-targets")
async def list_provider_test_targets(request: Request, provider_id: str,
                                     q: str = Query("", max_length=128),
                                     page: int = Query(1, ge=1),
                                     page_size: int = Query(25, ge=1, le=100)):
    return await _handle_list_provider_test_targets(request=request, provider_id=provider_id, q=q, page=page, page_size=page_size)


@router.post("")
async def create_platform_provider(request: Request, body: ProviderInput):
    return await _handle_create_platform_provider(request=request, body=body)


@router.put("/{provider_id}")
async def update_platform_provider(request: Request, provider_id: str, body: ProviderUpdateInput):
    return await _handle_update_platform_provider(request=request, provider_id=provider_id, body=body)


@router.get("/{provider_id}/assignments")
async def list_platform_provider_assignments(request: Request, provider_id: str,
                                             q: str = Query("", max_length=128),
                                             page: int = Query(1, ge=1),
                                             page_size: int = Query(25, ge=1, le=100)):
    return await _handle_list_platform_provider_assignments(request=request, provider_id=provider_id, q=q, page=page, page_size=page_size)


@router.post("/{provider_id}/assign")
async def assign_platform_provider(request: Request, provider_id: str, body: ProviderAssignInput):
    return await _handle_assign_platform_provider(request=request, provider_id=provider_id, body=body)


@router.put("/{provider_id}/assign/default")
async def set_default_platform_provider(request: Request, provider_id: str,
                                        body: ProviderDefaultInput):
    return await _handle_set_default_platform_provider(request=request, provider_id=provider_id, body=body)


@router.post("/{provider_id}/assign/revoke", status_code=204)
async def revoke_platform_provider_assignment(request: Request, provider_id: str,
                                              body: ProviderAssignInput):
    return await _handle_revoke_platform_provider_assignment(request=request, provider_id=provider_id, body=body)


@router.post("/{provider_id}/disable", status_code=204)
async def disable_platform_provider(request: Request, provider_id: str):
    return await _handle_disable_platform_provider(request=request, provider_id=provider_id)
