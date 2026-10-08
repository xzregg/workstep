from gateway.services.errors import GatewayError
from gateway.contracts import GatewayCall, ReplyEffects, RedirectTarget
import json

import re

from datetime import datetime, timezone

from typing import Literal

from urllib.parse import parse_qs, urlsplit


from pydantic import BaseModel, Field, field_validator, model_validator

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError

from gateway.services.external_identity import ExternalIdentityService

from gateway.services.identity_errors import IdentityError
from gateway.services.identity import COOKIE_NAME, IdentityService, csrf_token, public_user

from gateway.services.management_scope import organization_manager

from gateway.services.identity_api import _check_csrf, _set_session_cookie, _super_admin_request

from gateway.models import DirectoryEventReceipt, DirectorySyncState, IdentitySource, PlatformSetting
from gateway.services.organization_settings import option_key, source_options


"""Enterprise identity setup, scan callbacks and directory import."""


class SourceInput(BaseModel):
    provider: Literal["dingtalk", "wecom"]
    tenant_id: str = Field(min_length=1, max_length=128)
    client_id: str = Field(min_length=1, max_length=256)
    secret_env: str | None = Field(default=None, min_length=1, max_length=128)
    client_secret: str | None = Field(default=None, min_length=1, max_length=4096)
    login_enabled: bool = True
    sync_enabled: bool = True
    enabled: bool = True
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


class SelectedDirectoryInput(BaseModel):
    department_ids: list[str] = Field(min_length=1, max_length=10000)

    @field_validator('department_ids')
    @classmethod
    def valid_ids(cls, values):
        if any(not value or len(value) > 256 for value in values):
            raise ValueError('Invalid department identifier')
        return values


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


def _service(call: GatewayCall) -> ExternalIdentityService:
    return ExternalIdentityService(call.database)


def _connector(call: GatewayCall, provider: str):
    connector = call.identity_connectors.get(provider)
    if connector is None:
        raise GatewayError('unavailable', 'Identity connector unavailable')
    return connector


async def _begin(call: GatewayCall, source_id: str, binding: bool, return_to: str | None = None):
    identity = IdentityService(call.database)
    user_id = session_id = None
    if binding:
        token = call.tokens.get(COOKIE_NAME)
        user, auth_session = await identity.session_user(token)
        _check_csrf(call, token)
        user_id, session_id = user.id, auth_session.id
    source, state, nonce = await _service(call).begin(source_id, user_id, session_id, return_to)
    redirect_uri = str(call.callback_url('external_callback', source_id=source_id))
    if call.settings.public_origin:
        from urllib.parse import urlsplit
        redirect_uri = call.settings.public_origin + urlsplit(redirect_uri).path
    return {"authorization_url": _connector(call, source.provider).authorization_url(source, state, nonce, redirect_uri)}


async def create_source(call: GatewayCall, body: SourceInput):
    await _super_admin_request(call)
    if not body.client_secret and not body.secret_env:
        raise GatewayError('invalid', 'Application secret required')
    if body.secret_env and not re.fullmatch(r"[A-Z][A-Z0-9_]*", body.secret_env):
        raise GatewayError('invalid', 'Invalid secret environment variable')
    if body.provider == "wecom" and not body.agent_id:
        raise GatewayError('invalid', 'WeCom agent ID required')
    # Source ID is allocated before encryption so ciphertext is bound to its record.
    from uuid import uuid4
    credential_id = str(uuid4())
    options = {"login_enabled": body.login_enabled, "sync_enabled": body.sync_enabled, "enabled": body.enabled, "selected_department_ids": []}
    if body.client_secret:
        options['encrypted_secret'] = call.gateway_signer.encrypt_provider_secret(credential_id, body.client_secret)
        options["credential_id"] = credential_id
    source = await _service(call).create_source(body.provider, body.tenant_id, body.client_id, body.secret_env or 'WORKSTEP_IDENTITY_SECRET', body.agent_id, body.callback_token_env, body.callback_aes_key_env, options)
    return {"id": source.id, "provider": source.provider, "tenant_id": source.tenant_id,
            "client_id": source.client_id, "enabled": bool(source.enabled),
            "callback_configured": bool(source.callback_token_env)}


async def list_sources(call: GatewayCall, q: str = '',
                       provider: Literal['dingtalk', 'wecom'] | None = None,
                       status: Literal['enabled', 'disabled'] | None = None,
                       sort: Literal['created_at', 'tenant_id'] = 'created_at',
                       direction: Literal['asc', 'desc'] = 'desc',
                       page: int = 1, page_size: int = 25):
    _, allowed_sources = await organization_manager(call)
    conditions = [IdentitySource.id.in_(allowed_sources)] if allowed_sources is not None else []
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
    async with call.database.session() as session:
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
        options = {row.key.removeprefix("identity-options:"): json.loads(row.value_json) for row in (await session.scalars(select(PlatformSetting).where(PlatformSetting.key.in_([option_key(id) for id in ids])))).all()}
        now = datetime.now(timezone.utc)
        sources = [{'id': source.id, 'provider': source.provider, 'tenant_id': source.tenant_id,
                    'client_id': source.client_id, 'agent_id': source.agent_id,
                    'enabled': bool(source.enabled),
                    'login_enabled': options.get(source.id, {}).get('login_enabled', True),
                    'sync_enabled': options.get(source.id, {}).get('sync_enabled', True),
                    'secret_configured': bool(options.get(source.id, {}).get('encrypted_secret') or source.secret_env),
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


async def sync_directory(call: GatewayCall, source_id: str, body: DirectorySnapshot):
    await organization_manager(call, source_id=source_id, mutation=True)
    service = _service(call)
    await service.source(source_id)
    try:
        return await service.full_sync(
            source_id,
            [item.model_dump() for item in body.departments],
            [item.model_dump() for item in body.people],
            body.cursor,
        )
    except GatewayError as exc:
        if exc.reason == 'invalid':
            await service.record_sync_failure(source_id, 'snapshot_invalid')
        raise
    except Exception:
        await service.record_sync_failure(source_id, 'snapshot_apply_failed')
        raise


async def reconcile_directory(call: GatewayCall, source_id: str):
    await organization_manager(call, source_id=source_id, mutation=True)
    service = _service(call)
    source = await service.source(source_id, purpose="sync")
    selected = (await source_options(call.database, source_id)).get('selected_department_ids', [])
    if selected == []:
        raise GatewayError('invalid', 'Select departments before syncing')
    try:
        connector = _connector(call, source.provider)
        snapshot = await connector.fetch_directory(source, selected_department_ids=selected) if selected is not None else await connector.fetch_directory(source)
    except Exception as exc:
        await service.record_sync_failure(source_id, 'provider_unavailable')
        raise GatewayError('upstream_failed', 'Directory provider unavailable') from exc
    try:
        return await service.full_sync(source_id, snapshot["departments"], snapshot["people"],
                                       snapshot.get('cursor'), selected_department_ids=selected)
    except Exception as exc:
        await service.record_sync_failure(source_id, 'snapshot_invalid' if isinstance(exc, GatewayError) and exc.reason == 'invalid' else 'snapshot_apply_failed')
        raise


async def apply_directory_event(call: GatewayCall, source_id: str, body: PersonEvent):
    await organization_manager(call, source_id=source_id, mutation=True)
    if body.kind == "person_upsert" and not body.display_name:
        raise GatewayError('invalid', 'Display name required')
    applied = await _service(call).apply_person_event(source_id, body.event_id, body.kind, body.subject, body.display_name, body.department_ids)
    return {"applied": applied}


async def disable_source(call: GatewayCall, source_id: str):
    await _super_admin_request(call)
    await _service(call).disable_source(source_id)


async def external_start(call: GatewayCall, source_id: str, body: ExternalStartInput | None = None):
    await call.identity_rate_limiter.check('external_start', call.peer.host if call.peer else 'unknown')
    return await _begin(call, source_id, False, body.return_to if body else None)


async def identity_sources(call: GatewayCall):
    from gateway.services.login_policy import scan_sources
    async with call.database.session() as session:
        sources = await scan_sources(session)
    return {"sources": [{"id": source.id, "provider": source.provider} for source, _ in sources]}


async def external_bind_start(call: GatewayCall, source_id: str):
    return await _begin(call, source_id, True)


async def external_callback(call: GatewayCall, response: ReplyEffects, source_id: str,
                            state: str, code: str | None = None, authCode: str | None = None,
                            error: str | None = None):
    authorization_code = code or authCode
    if error or not authorization_code:
        return_to = await _service(call).failure_return_to(source_id, state)
        if return_to:
            failure = "cancelled" if error in (None, "access_denied") else "unavailable"
            separator = "&" if "?" in return_to else "?"
            return RedirectTarget(f'{return_to}{separator}scan_error={failure}')
        raise GatewayError('bad_input', 'Authorization code missing')
    source = await _service(call).source(source_id)
    browser_session_id = None
    token = call.tokens.get(COOKIE_NAME)
    if token:
        try:
            _, auth_session = await IdentityService(call.database).session_user(token)
            browser_session_id = auth_session.id
        except IdentityError:
            pass
    try:
        user, new_token, return_to = await _service(call).complete(source_id, state, authorization_code, _connector(call, source.provider), browser_session_id)
    except GatewayError as exc:
        return_to = await _service(call).failure_return_to(source_id, state)
        if return_to:
            failure = 'expired' if exc.reason in ('bad_input', 'unauthenticated', 'conflict') else 'denied' if exc.reason == 'forbidden' else 'unavailable'
            separator = "&" if "?" in return_to else "?"
            return RedirectTarget(f'{return_to}{separator}scan_error={failure}')
        raise
    if return_to:
        redirect = RedirectTarget(return_to if user.status == 'active' else '/auth/pending')
        if new_token:
            _set_session_cookie(redirect, new_token, call)
        return redirect
    if new_token:
        _set_session_cookie(response, new_token, call)
    if user.status == "pending":
        response.phase = 'pending'
    return {"user": public_user(user), **({"csrf_token": csrf_token(new_token)} if new_token else {})}


async def update_source(call: GatewayCall, source_id: str, body: SourceInput):
    await _super_admin_request(call)
    if body.provider == 'wecom' and not body.agent_id:
        raise GatewayError('invalid', 'WeCom agent ID required')
    if body.secret_env and not re.fullmatch(r'[A-Z][A-Z0-9_]*', body.secret_env):
        raise GatewayError('invalid', 'Invalid secret environment variable')
    async with call.database.session() as session:
        async with session.begin():
            source = await session.get(IdentitySource, source_id)
            if source is None: raise GatewayError('not_found', 'Identity source not found')
            if source.provider != body.provider:
                raise GatewayError('invalid', 'Provider cannot change')
            duplicate = await session.scalar(select(IdentitySource.id).where(
                IdentitySource.provider == body.provider, IdentitySource.tenant_id == body.tenant_id,
                IdentitySource.id != source_id))
            if duplicate:
                raise GatewayError('conflict', 'Enterprise identity source already exists')
            source.tenant_id = body.tenant_id
            row = await session.get(PlatformSetting, option_key(source_id))
            options = json.loads(row.value_json) if row else {}
            if body.client_secret:
                options['credential_id'] = option_key(source_id)
                options['encrypted_secret'] = call.gateway_signer.encrypt_provider_secret(option_key(source_id), body.client_secret)
            options.update(login_enabled=body.login_enabled, sync_enabled=body.sync_enabled)
            if row: row.value_json = json.dumps(options)
            else: session.add(PlatformSetting(key=option_key(source_id), value_json=json.dumps(options)))
            source.client_id, source.agent_id, source.enabled = body.client_id, body.agent_id, int(body.enabled)
            if body.secret_env: source.secret_env = body.secret_env
            try:
                await session.flush()
            except IntegrityError as exc:
                raise GatewayError('conflict', 'Enterprise identity source already exists') from exc
            from gateway.services.login_policy import ensure_login_method
            await ensure_login_method(session)
    return {'id': source_id}


async def preview_directory(call: GatewayCall, source_id: str):
    await organization_manager(call, source_id=source_id)
    source = await _service(call).source(source_id, purpose='sync')
    try:
        snapshot = await _connector(call, source.provider).fetch_directory(source, departments_only=True)
    except Exception as exc:
        raise GatewayError('upstream_failed', 'Directory provider unavailable') from exc
    options = await source_options(call.database, source_id)
    return {'departments': snapshot['departments'], 'selected_department_ids': options.get('selected_department_ids', [])}


async def start_selected_sync(call: GatewayCall, source_id: str, body: SelectedDirectoryInput):
    await organization_manager(call, source_id=source_id, mutation=True)
    return await call.directory_reconciler.jobs.start(source_id, body.department_ids)


async def latest_selected_sync(call: GatewayCall, source_id: str):
    await organization_manager(call, source_id=source_id)
    await _service(call).source(source_id, purpose='sync')
    return await call.directory_reconciler.jobs.latest(source_id)
