"""Enterprise identity setup, scan callbacks and directory import."""

import json
import re
from datetime import datetime, timezone
from typing import Literal
from urllib.parse import parse_qs, urlsplit

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import func, or_, select

from .external_identity import ExternalIdentityService
from .identity import COOKIE_NAME, IdentityService, csrf_token, public_user
from .identity_api import _check_csrf, _set_session_cookie, _super_admin_read, _super_admin_request
from .models import DirectoryEventReceipt, DirectorySyncState, IdentitySource

router = APIRouter(prefix="/api")


class SourceInput(BaseModel):
    provider: Literal["dingtalk", "wecom"]
    tenant_id: str = Field(min_length=1, max_length=128)
    client_id: str = Field(min_length=1, max_length=256)
    secret_env: str = Field(min_length=1, max_length=128)
    agent_id: str | None = Field(default=None, max_length=128)
    callback_token_env: str | None = Field(default=None, max_length=128)
    callback_aes_key_env: str | None = Field(default=None, max_length=128)

    @model_validator(mode="after")
    def valid_callback_configuration(self):
        if bool(self.callback_token_env) != bool(self.callback_aes_key_env):
            raise ValueError("Both callback environment references are required")
        for reference in (self.callback_token_env, self.callback_aes_key_env):
            if reference and not re.fullmatch(r"[A-Z][A-Z0-9_]*", reference):
                raise ValueError("Invalid callback secret environment variable")
        return self


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
    cursor: str | None = Field(default=None, max_length=256)


class PersonEvent(BaseModel):
    event_id: str = Field(min_length=1, max_length=256)
    kind: Literal["person_upsert", "person_delete"]
    subject: str = Field(min_length=1, max_length=256)
    display_name: str | None = Field(default=None, max_length=256)
    department_ids: list[str] = []


class ExternalStartInput(BaseModel):
    return_to: str | None = Field(default=None, max_length=2048)

    @field_validator("return_to")
    @classmethod
    def safe_return_to(cls, value: str | None) -> str | None:
        if value is not None and not (value == "/" or value.startswith("/desktop/login?")
                                       or value.startswith("/auth?")):
            raise ValueError("Unsupported scan return path")
        if value and (value.startswith("//") or "\\" in value or "\n" in value or "\r" in value):
            raise ValueError("Invalid scan return path")
        if value and value.startswith("/auth?"):
            parsed = urlsplit(value)
            params = parse_qs(parsed.query, keep_blank_values=True)
            target = params.get("next", [])
            if (parsed.path != "/auth" or parsed.fragment or set(params) != {"next"}
                    or len(target) != 1 or not target[0].startswith("/")
                    or target[0].startswith("//") or "\\" in target[0]
                    or "\n" in target[0] or "\r" in target[0]):
                raise ValueError("Invalid portal return path")
        return value


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
        body.callback_token_env, body.callback_aes_key_env,
    )
    return {"id": source.id, "provider": source.provider, "tenant_id": source.tenant_id,
            "client_id": source.client_id, "enabled": bool(source.enabled),
            "callback_configured": bool(source.callback_token_env)}


@router.get("/admin/identity-sources")
async def list_sources(request: Request, q: str = Query('', max_length=128),
                       provider: Literal['dingtalk', 'wecom'] | None = None,
                       status: Literal['enabled', 'disabled'] | None = None,
                       sort: Literal['created_at', 'tenant_id'] = 'created_at',
                       direction: Literal['asc', 'desc'] = 'desc',
                       page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100)):
    await _super_admin_read(request)
    conditions = []
    if provider:
        conditions.append(IdentitySource.provider == provider)
    if status:
        conditions.append(IdentitySource.enabled == int(status == 'enabled'))
    if q.strip():
        escaped = q.strip().replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
        pattern = f'%{escaped}%'
        conditions.append(or_(IdentitySource.tenant_id.ilike(pattern, escape='\\'),
                              IdentitySource.client_id.ilike(pattern, escape='\\')))
    column = {'created_at': IdentitySource.created_at, 'tenant_id': IdentitySource.tenant_id}[sort]
    ordered = column.asc() if direction == 'asc' else column.desc()
    async with request.app.state.database.session() as session:
        total = await session.scalar(select(func.count()).select_from(IdentitySource).where(*conditions))
        rows = (await session.scalars(select(IdentitySource).where(*conditions)
            .order_by(ordered, IdentitySource.id).offset((page - 1) * page_size).limit(page_size))).all()
        ids = [source.id for source in rows]
        states = {}
        pending = {}
        if ids:
            states = {state.source_id: state for state in (await session.scalars(select(DirectorySyncState)
                .where(DirectorySyncState.source_id.in_(ids)))).all()}
            pending = {source_id: (count, oldest) for source_id, count, oldest in (await session.execute(
                select(DirectoryEventReceipt.source_id, func.count(), func.min(DirectoryEventReceipt.received_at))
                .where(DirectoryEventReceipt.source_id.in_(ids), DirectoryEventReceipt.status == 'pending')
                .group_by(DirectoryEventReceipt.source_id)
            )).all()}
        now = datetime.now(timezone.utc)
        sources = [{'id': source.id, 'provider': source.provider, 'tenant_id': source.tenant_id,
                    'client_id': source.client_id, 'agent_id': source.agent_id,
                    'enabled': bool(source.enabled),
                    'callback_configured': bool(source.callback_token_env),
                    'created_at': source.created_at.isoformat(),
                    'sync_state': ({
                        'last_attempt_at': states[source.id].last_attempt_at.isoformat()
                            if states[source.id].last_attempt_at else None,
                        'last_success_at': states[source.id].last_success_at.isoformat()
                            if states[source.id].last_success_at else None,
                        'last_error_code': states[source.id].last_error_code,
                        'cursor': states[source.id].cursor,
                        'changes': json.loads(states[source.id].changes_json)
                            if states[source.id].changes_json else None,
                    } if source.id in states else None),
                    'pending_callbacks': pending.get(source.id, (0, None))[0],
                    'oldest_pending_at': pending[source.id][1].isoformat()
                        if source.id in pending and pending[source.id][1] else None,
                    'pending_delay_seconds': max(0, int((now - pending[source.id][1].replace(
                        tzinfo=pending[source.id][1].tzinfo or timezone.utc)).total_seconds()))
                        if source.id in pending and pending[source.id][1] else None,
                    } for source in rows]
    return {'sources': sources, 'total': total, 'page': page, 'page_size': page_size}


@router.post("/admin/identity-sources/{source_id}/sync")
async def sync_directory(request: Request, source_id: str, body: DirectorySnapshot):
    await _super_admin_request(request)
    service = _service(request)
    await service.source(source_id)
    try:
        return await service.full_sync(
            source_id,
            [item.model_dump() for item in body.departments],
            [item.model_dump() for item in body.people],
            body.cursor,
        )
    except HTTPException as exc:
        if exc.status_code == 422:
            await service.record_sync_failure(source_id, 'snapshot_invalid')
        raise
    except Exception:
        await service.record_sync_failure(source_id, 'snapshot_apply_failed')
        raise


@router.post("/admin/identity-sources/{source_id}/reconcile")
async def reconcile_directory(request: Request, source_id: str):
    await _super_admin_request(request)
    service = _service(request)
    source = await service.source(source_id)
    try:
        snapshot = await _connector(request, source.provider).fetch_directory(source)
    except Exception as exc:
        await service.record_sync_failure(source_id, 'provider_unavailable')
        raise HTTPException(status_code=502, detail="Directory provider unavailable") from exc
    try:
        return await service.full_sync(source_id, snapshot["departments"], snapshot["people"],
                                       snapshot.get('cursor'))
    except Exception as exc:
        await service.record_sync_failure(source_id,
                                          'snapshot_invalid' if isinstance(exc, HTTPException)
                                          and exc.status_code == 422 else 'snapshot_apply_failed')
        raise


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


async def _begin(request: Request, source_id: str, binding: bool, return_to: str | None = None):
    identity = IdentityService(request.app.state.database)
    user_id = session_id = None
    if binding:
        token = request.cookies.get(COOKIE_NAME)
        user, auth_session = await identity.session_user(token)
        _check_csrf(request, token)
        user_id, session_id = user.id, auth_session.id
    source, state, nonce = await _service(request).begin(source_id, user_id, session_id, return_to)
    redirect_uri = str(request.url_for("external_callback", source_id=source_id))
    return {"authorization_url": _connector(request, source.provider).authorization_url(
        source, state, nonce, redirect_uri,
    )}


@router.post("/auth/external/{source_id}/start")
async def external_start(request: Request, source_id: str, body: ExternalStartInput | None = None):
    await request.app.state.identity_rate_limiter.check(
        "external_start", request.client.host if request.client else "unknown",
    )
    return await _begin(request, source_id, False, body.return_to if body else None)


@router.get("/auth/identity-sources")
async def identity_sources(request: Request):
    sources = await _service(request).enabled_sources()
    return {"sources": [{"id": source.id, "provider": source.provider,
                         "tenant_id": source.tenant_id} for source in sources]}


@router.post("/auth/external/{source_id}/bind/start")
async def external_bind_start(request: Request, source_id: str):
    return await _begin(request, source_id, True)


@router.get("/auth/external/{source_id}/callback")
async def external_callback(request: Request, response: Response, source_id: str,
                            state: str, code: str | None = None, authCode: str | None = None,
                            error: str | None = None):
    authorization_code = code or authCode
    if error or not authorization_code:
        return_to = await _service(request).failure_return_to(source_id, state)
        if return_to:
            failure = "cancelled" if error in (None, "access_denied") else "unavailable"
            separator = "&" if "?" in return_to else "?"
            return RedirectResponse(f"{return_to}{separator}scan_error={failure}", status_code=303)
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
    try:
        user, new_token, return_to = await _service(request).complete(
            source_id, state, authorization_code, _connector(request, source.provider), browser_session_id,
        )
    except HTTPException as exc:
        return_to = await _service(request).failure_return_to(source_id, state)
        if return_to:
            failure = ("expired" if exc.status_code in (400, 401, 409) else
                       "denied" if exc.status_code == 403 else "unavailable")
            separator = "&" if "?" in return_to else "?"
            return RedirectResponse(f"{return_to}{separator}scan_error={failure}", status_code=303)
        raise
    if return_to:
        redirect = RedirectResponse(return_to if user.status == "active" else "/auth/pending", status_code=303)
        if new_token:
            _set_session_cookie(redirect, new_token, request)
        return redirect
    if new_token:
        _set_session_cookie(response, new_token, request)
    if user.status == "pending":
        response.status_code = 202
    return {"user": public_user(user), **({"csrf_token": csrf_token(new_token)} if new_token else {})}
