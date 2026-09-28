"""Enterprise identity setup, scan callbacks and directory import."""

import re
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from .external_identity import ExternalIdentityService
from .identity import COOKIE_NAME, IdentityService, csrf_token, public_user
from .identity_api import _check_csrf, _set_session_cookie, _super_admin_request

router = APIRouter(prefix="/api")


class SourceInput(BaseModel):
    provider: Literal["dingtalk", "wecom"]
    tenant_id: str = Field(min_length=1, max_length=128)
    client_id: str = Field(min_length=1, max_length=256)
    secret_env: str = Field(min_length=1, max_length=128)
    agent_id: str | None = Field(default=None, max_length=128)


class DepartmentInput(BaseModel):
    external_id: str = Field(min_length=1, max_length=256)
    display_name: str = Field(min_length=1, max_length=256)
    parent_external_id: str | None = None


class PersonInput(BaseModel):
    subject: str = Field(min_length=1, max_length=256)
    display_name: str = Field(min_length=1, max_length=256)
    department_ids: list[str]


class DirectorySnapshot(BaseModel):
    departments: list[DepartmentInput]
    people: list[PersonInput]


class PersonEvent(BaseModel):
    event_id: str = Field(min_length=1, max_length=256)
    kind: Literal["person_upsert", "person_delete"]
    subject: str = Field(min_length=1, max_length=256)
    display_name: str | None = Field(default=None, max_length=256)
    department_ids: list[str] = []


def _service(request: Request) -> ExternalIdentityService:
    return ExternalIdentityService(request.app.state.database)


def _connector(request: Request, provider: str):
    connector = request.app.state.identity_connectors.get(provider)
    if connector is None:
        raise HTTPException(status_code=503, detail="Identity connector unavailable")
    return connector


@router.post("/admin/identity-sources", status_code=201)
async def create_source(request: Request, body: SourceInput):
    await _super_admin_request(request)
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*", body.secret_env):
        raise HTTPException(status_code=422, detail="Invalid secret environment variable")
    if body.provider == "wecom" and not body.agent_id:
        raise HTTPException(status_code=422, detail="WeCom agent ID required")
    source = await _service(request).create_source(
        body.provider, body.tenant_id, body.client_id, body.secret_env, body.agent_id,
    )
    return {"id": source.id, "provider": source.provider, "tenant_id": source.tenant_id,
            "client_id": source.client_id, "enabled": bool(source.enabled)}


@router.post("/admin/identity-sources/{source_id}/sync")
async def sync_directory(request: Request, source_id: str, body: DirectorySnapshot):
    await _super_admin_request(request)
    return await _service(request).full_sync(
        source_id,
        [item.model_dump() for item in body.departments],
        [item.model_dump() for item in body.people],
    )


@router.post("/admin/identity-sources/{source_id}/reconcile")
async def reconcile_directory(request: Request, source_id: str):
    await _super_admin_request(request)
    service = _service(request)
    source = await service.source(source_id)
    try:
        snapshot = await _connector(request, source.provider).fetch_directory(source)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Directory provider unavailable") from exc
    return await service.full_sync(source_id, snapshot["departments"], snapshot["people"])


@router.post("/admin/identity-sources/{source_id}/events")
async def apply_directory_event(request: Request, source_id: str, body: PersonEvent):
    await _super_admin_request(request)
    if body.kind == "person_upsert" and not body.display_name:
        raise HTTPException(status_code=422, detail="Display name required")
    applied = await _service(request).apply_person_event(
        source_id, body.event_id, body.kind, body.subject, body.display_name, body.department_ids,
    )
    return {"applied": applied}


@router.post("/admin/identity-sources/{source_id}/disable", status_code=204)
async def disable_source(request: Request, source_id: str):
    await _super_admin_request(request)
    await _service(request).disable_source(source_id)


async def _begin(request: Request, source_id: str, binding: bool):
    identity = IdentityService(request.app.state.database)
    user_id = session_id = None
    if binding:
        token = request.cookies.get(COOKIE_NAME)
        user, auth_session = await identity.session_user(token)
        _check_csrf(request, token)
        user_id, session_id = user.id, auth_session.id
    source, state, nonce = await _service(request).begin(source_id, user_id, session_id)
    redirect_uri = str(request.url_for("external_callback", source_id=source_id))
    return {"authorization_url": _connector(request, source.provider).authorization_url(
        source, state, nonce, redirect_uri,
    )}


@router.post("/auth/external/{source_id}/start")
async def external_start(request: Request, source_id: str):
    await request.app.state.identity_rate_limiter.check(
        "external_start", request.client.host if request.client else "unknown",
    )
    return await _begin(request, source_id, False)


@router.post("/auth/external/{source_id}/bind/start")
async def external_bind_start(request: Request, source_id: str):
    return await _begin(request, source_id, True)


@router.get("/auth/external/{source_id}/callback")
async def external_callback(request: Request, response: Response, source_id: str,
                            state: str, code: str | None = None, authCode: str | None = None):
    authorization_code = code or authCode
    if not authorization_code:
        raise HTTPException(status_code=400, detail="Authorization code missing")
    source = await _service(request).source(source_id)
    browser_session_id = None
    token = request.cookies.get(COOKIE_NAME)
    if token:
        try:
            _, auth_session = await IdentityService(request.app.state.database).session_user(token)
            browser_session_id = auth_session.id
        except HTTPException:
            pass
    user, new_token = await _service(request).complete(
        source_id, state, authorization_code, _connector(request, source.provider), browser_session_id,
    )
    if new_token:
        _set_session_cookie(response, new_token)
    if user.status == "pending":
        response.status_code = 202
    return {"user": public_user(user), **({"csrf_token": csrf_token(new_token)} if new_token else {})}
