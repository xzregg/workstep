from gateway.services.errors import GatewayError
from gateway.contracts import GatewayCall, CredentialGrant, JsonValue
import asyncio

import hashlib

import hmac

import json

import re

import secrets

from datetime import datetime, timedelta, timezone

from typing import Literal

from uuid import uuid4

from argon2 import PasswordHasher

from argon2.exceptions import VerificationError


from pydantic import BaseModel, Field, ValidationError, field_validator

from sqlalchemy import select, update

from gateway.services.identity import COOKIE_NAME, IdentityService

from gateway.services.identity_api import _check_csrf

from gateway.models import AuditEvent, Device, PlatformProject, PlatformShare, PlatformShareSession, User

from gateway.services.project_access_api import effective_project_access

from gateway.services.providers_api import compiled_provider_access


"""Gateway-owned public share credentials and visitor sessions."""


SHARE_SESSION_COOKIE = "platform_share_session"


_hasher = PasswordHasher()


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class CreateShareInput(BaseModel):
    project_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
    task_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
    mode: Literal["read_only", "interactive"] = "read_only"
    title: str = Field(default="", max_length=256)
    password: str | None = Field(default=None, min_length=4, max_length=200)
    expires_at: datetime | None = None


class UnlockShareInput(BaseModel):
    password: str = Field(default="", max_length=200)


class ShareMessageInput(BaseModel):
    content: str = Field(min_length=1, max_length=65536)


class ShareReviewInput(BaseModel):
    review_run_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    comment: str | None = Field(default=None, max_length=4096)


class ShareInteractionInput(BaseModel):
    data: dict


class ShareGitCommitInput(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=10000)
    message: str = Field(min_length=1, max_length=100000)
    snapshot: str = Field(pattern=r"^[0-9a-f]{64}$")

    @field_validator("message")
    @classmethod
    def valid_message(cls, value: str) -> str:
        if not value.strip() or "\0" in value:
            raise ValueError("Commit message required")
        return value.strip()


class ShareGitSyncInput(BaseModel):
    branch: str = Field(min_length=1, max_length=1024)
    snapshot: str = Field(pattern=r"^[0-9a-f]{64}$")
    remote: str | None = Field(default=None, min_length=1, max_length=1024)
    target_branch: str | None = Field(default=None, min_length=1, max_length=1024)
    set_upstream: bool = False


class ShareGitSwitchInput(BaseModel):
    branch: str = Field(min_length=1, max_length=1024)
    snapshot: str = Field(pattern=r"^[0-9a-f]{64}$")
    remote: str | None = Field(default=None, min_length=1, max_length=1024)


class ShareGitBranchCreateInput(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    base_branch: str = Field(min_length=1, max_length=1024)
    base_head: str = Field(pattern=r"^[0-9a-f]{40,64}$")
    snapshot: str = Field(pattern=r"^[0-9a-f]{64}$")
    base_remote: str | None = Field(default=None, min_length=1, max_length=1024)


class ShareGitBranchDeleteInput(BaseModel):
    branch: str = Field(min_length=1, max_length=1024)
    head: str = Field(pattern=r"^[0-9a-f]{40,64}$")
    snapshot: str = Field(pattern=r"^[0-9a-f]{64}$")


def _share_csrf(session_token: str) -> str:
    return hashlib.sha256(f"share-csrf:{session_token}".encode()).hexdigest()


def _check_share_csrf(call: GatewayCall) -> None:
    session_token = call.tokens.get(SHARE_SESSION_COOKIE, '')
    provided = call.proofs.get('x-share-csrf', '')
    if not provided or not hmac.compare_digest(provided, _share_csrf(session_token)):
        raise GatewayError('forbidden', 'Share CSRF token required')


async def _bounded_share_json(call: GatewayCall):
    raw = bytearray()
    async for chunk in call.payload():
        raw.extend(chunk)
        if len(raw) > 262144:
            raise GatewayError('too_large', 'Share message too large')
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise GatewayError('invalid', 'Invalid share message') from exc


async def _share_upload_body(call: GatewayCall) -> bytes:
    filename = call.proofs.get('x-share-filename', '')
    if not filename or len(filename) > 512:
        raise GatewayError('invalid', 'Attachment filename required')
    raw = bytearray()
    async for chunk in call.payload():
        raw.extend(chunk)
        if len(raw) > 25_000_000:
            raise GatewayError('too_large', 'Attachment exceeds 25 MB')
    if not raw:
        raise GatewayError('invalid', 'Attachment is empty')
    return bytes(raw)


async def _share_message_body(call: GatewayCall) -> bytes:
    try:
        body = ShareMessageInput.model_validate(await _bounded_share_json(call))
    except ValidationError as exc:
        raise GatewayError('invalid', 'Invalid share message') from exc
    if not body.content.strip():
        raise GatewayError('invalid', 'Share message required')
    return json.dumps({"content": body.content}, separators=(",", ":")).encode()


async def _share_review_body(call: GatewayCall) -> bytes:
    try:
        body = ShareReviewInput.model_validate(await _bounded_share_json(call))
    except ValidationError as exc:
        raise GatewayError('invalid', 'Invalid review decision') from exc
    return json.dumps({"review_run_id": body.review_run_id, "comment": body.comment},
                      separators=(",", ":")).encode()


async def _share_interaction_body(call: GatewayCall) -> bytes:
    try:
        body = ShareInteractionInput.model_validate(await _bounded_share_json(call))
    except ValidationError as exc:
        raise GatewayError('invalid', 'Invalid interaction response') from exc
    return json.dumps({"data": body.data}, separators=(",", ":")).encode()


async def _share_git_commit_body(call: GatewayCall) -> bytes:
    try:
        body = ShareGitCommitInput.model_validate(await _bounded_share_json(call))
    except ValidationError as exc:
        raise GatewayError('invalid', 'Invalid Git commit') from exc
    return json.dumps(body.model_dump(), separators=(",", ":")).encode()


async def _share_git_sync_body(call: GatewayCall) -> bytes:
    try:
        body = ShareGitSyncInput.model_validate(await _bounded_share_json(call))
    except ValidationError as exc:
        raise GatewayError('invalid', 'Invalid Git sync request') from exc
    return json.dumps(body.model_dump(exclude_none=True), separators=(",", ":")).encode()


async def _share_git_branch_body(call: GatewayCall, kind: str) -> bytes:
    model = {"git_switch": ShareGitSwitchInput,
             "git_branch_create": ShareGitBranchCreateInput,
             "git_branch_delete": ShareGitBranchDeleteInput}[kind]
    try:
        body = model.model_validate(await _bounded_share_json(call))
    except ValidationError as exc:
        raise GatewayError('invalid', 'Invalid Git branch request') from exc
    return json.dumps(body.model_dump(exclude_none=True), separators=(",", ":")).encode()


async def can_create_platform_share(session, user_id: str, project: PlatformProject) -> bool:
    from gateway.services.identity import IdentityService
    from gateway.services.capabilities import capability_rules
    from gateway.services.permission_subjects import active_group_ids
    from gateway.models import GroupCapabilityAssignment
    if await IdentityService.super_admin_in_session(session, user_id):
        return True
    access = await effective_project_access(session, user_id, project.id)
    if access != "edit":
        return False
    rules = await capability_rules(session, user_id)
    group_rules = (await session.scalars(select(GroupCapabilityAssignment).where(
        GroupCapabilityAssignment.group_id.in_(active_group_ids(user_id)),
        GroupCapabilityAssignment.project_id == project.id,
        GroupCapabilityAssignment.capability == "share.create",
        GroupCapabilityAssignment.revoked_at.is_(None),
    ))).all()
    applicable = [rule for rule in rules if rule.capability == "share.create" and (
                  rule.scope_type == "global"
                  or (rule.scope_type == "device" and rule.scope_id == project.device_id)
                  or (rule.scope_type == "project" and rule.scope_id == project.id))]
    return (any(rule.effect == "allow" for rule in (*applicable, *group_rules))
            and not any(rule.effect == "deny" for rule in (*applicable, *group_rules)))


async def _live_share(call: GatewayCall, token: str) -> PlatformShare:
    if len(token) > 128:
        raise GatewayError('not_found', 'Share unavailable')
    async with call.database.session() as session:
        share = await session.scalar(select(PlatformShare).where(
            PlatformShare.token_hash == _digest(token),
        ))
        if share is None or share.revoked_at is not None or share.status == "revoked":
            raise GatewayError('not_found', 'Share unavailable')
        project = await session.get(PlatformProject, share.project_id)
        device = await session.get(Device, share.device_id)
    if share.expires_at is not None and _utc(share.expires_at) <= datetime.now(timezone.utc):
        raise GatewayError('not_found', 'Share expired')
    if share.status == "paused":
        raise GatewayError('unavailable', 'Share paused')
    if share.status != "active":
        raise GatewayError('not_found', 'Share unavailable')
    if (project is None or project.status != "active"
            or project.access_mode != "remote_published"
            or project.device_id != share.device_id):
        raise GatewayError('unavailable', 'Share project unavailable')
    if device is None or device.status != "active":
        raise GatewayError('unavailable', 'Share paused')
    return share


async def _authorized_visitor(call: GatewayCall, token: str, *, touch: bool = False):
    share = await _live_share(call, token)
    session_token = call.tokens.get(SHARE_SESSION_COOKIE)
    if not session_token:
        raise GatewayError('unauthenticated', 'Share session required')
    async with call.database.session() as session:
        async with session.begin():
            visit = await session.scalar(select(PlatformShareSession).where(
                PlatformShareSession.session_token_hash == _digest(session_token),
                PlatformShareSession.share_id == share.id,
                PlatformShareSession.revoked_at.is_(None),
            ))
            project = await session.get(PlatformProject, share.project_id)
            if visit is None or _utc(visit.expires_at) <= datetime.now(timezone.utc):
                raise GatewayError('unauthenticated', 'Share session expired')
            if project is None or project.device_id != share.device_id:
                raise GatewayError('unavailable', 'Share project unavailable')
            if touch:
                visit.last_seen_at = datetime.now(timezone.utc)
    return share, project


async def _proxy_share_step(call: GatewayCall, token: str, step_key: str, action: str):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", step_key):
        raise GatewayError('not_found', 'Step unavailable')
    return await _proxy_share_request(call, token, f'/api/platform-share/steps/{step_key}/{action}', write=True, body_kind='message' if action != 'cancel' else None)


async def _interactive_provider_scope(call: GatewayCall, share: PlatformShare, project: PlatformProject) -> list[str]:
    async with call.database.session() as session:
        creator = await session.get(User, share.created_by_user_id)
        if creator is None or creator.status != 'active' or not await can_create_platform_share(session, creator.id, project):
            raise GatewayError('forbidden', 'Share creator authorization revoked')
    ids, _ = await compiled_provider_access(call.database, share.device_id, share.created_by_user_id)
    return ids


async def _proxy_share_request(call: GatewayCall, token: str, target_path: str,
                               *, write: bool = False,
                               interactive_read: bool = False,
                               body_kind: Literal["message", "review", "interaction", "upload", "git_commit", "git_sync", "git_switch", "git_branch_create", "git_branch_delete"] | None = None):
    share, project = await _authorized_visitor(call, token, touch=True)
    if write or interactive_read:
        if share.mode != "interactive":
            raise GatewayError('forbidden', 'Share is read-only')
    if write:
        _check_share_csrf(call)
    share_body = await _share_message_body(call) if body_kind == 'message' else await _share_review_body(call) if body_kind == 'review' else await _share_interaction_body(call) if body_kind == 'interaction' else await _share_git_commit_body(call) if body_kind == 'git_commit' else await _share_git_sync_body(call) if body_kind == 'git_sync' else await _share_git_branch_body(call, body_kind) if body_kind in ('git_switch', 'git_branch_create', 'git_branch_delete') else await _share_upload_body(call) if body_kind == 'upload' else b'' if write else None
    connections = call.control_connections
    if not connections.is_online(share.device_id):
        raise GatewayError('unavailable', 'Shared device offline')

    async def authorize_stream():
        current, current_project = await _authorized_visitor(call, token)
        if (current.id != share.id or current.device_id != share.device_id
                or current_project.host_project_id != project.host_project_id
                or current.mode != share.mode):
            raise GatewayError('forbidden', 'Share changed')
        if share.mode == 'interactive':
            current_ids = await _interactive_provider_scope(call, current, current_project)
            if set(provider_ids) - set(current_ids):
                raise GatewayError('forbidden', 'Share provider authorization revoked')

    provider_ids = []
    if share.mode == 'interactive':
        provider_ids = await _interactive_provider_scope(call, share, project)
    ticket = call.gateway_signer.sign_platform_share_ticket(gateway_id=call.settings.gateway_id, device_id=share.device_id, share_id=share.id, project_id=share.project_id, host_project_id=project.host_project_id, task_id=share.task_id, mode=share.mode, provider_ids=provider_ids)
    try:
        connection = await connections.request_data(share.device_id)
        response = await connection.proxy_http(call, share_ticket=ticket, target_path=target_path, authorization_check=authorize_stream, **{'share_body': share_body} if write else {})
        response.headers["Cache-Control"] = "no-store"
        return response
    except (ConnectionError, asyncio.TimeoutError) as exc:
        raise GatewayError('unavailable', 'Shared device unavailable') from exc


async def create_platform_share(call: GatewayCall, body: CreateShareInput):
    origin = call.settings.public_origin
    if origin is None:
        raise GatewayError('unavailable', 'Public Gateway origin unavailable')
    auth_token = call.tokens.get(COOKIE_NAME)
    actor, _ = await IdentityService(call.database).session_user(auth_token)
    _check_csrf(call, auth_token)
    if actor.status != "active":
        raise GatewayError('forbidden', 'Account unavailable')
    if body.expires_at is not None:
        expiry = _utc(body.expires_at)
        if not datetime.now(timezone.utc) < expiry <= datetime.now(timezone.utc) + timedelta(days=90):
            raise GatewayError('invalid', 'Invalid share expiration')
    else:
        expiry = None
    password_hash = (await asyncio.to_thread(_hasher.hash, body.password)) if body.password else None
    token = secrets.token_urlsafe(32)
    async with call.database.session() as session:
        async with session.begin():
            project = await session.get(PlatformProject, body.project_id)
            device = await session.get(Device, project.device_id) if project else None
            if (project is None or project.status != "active"
                    or project.access_mode != "remote_published"
                    or device is None or device.status != "active"):
                raise GatewayError('not_found', 'Published project unavailable')
            if not await can_create_platform_share(session, actor.id, project):
                raise GatewayError('forbidden', 'Share creation unavailable')
            share = PlatformShare(
                id=str(uuid4()), token_hash=_digest(token), device_id=device.id,
                project_id=project.id, task_id=body.task_id, mode=body.mode,
                title=body.title.strip(), password_hash=password_hash,
                created_by_user_id=actor.id, status="active", expires_at=expiry,
            )
            session.add(share)
            session.add(AuditEvent(
                id=str(uuid4()), user_id=actor.id, device_id=device.id,
                action="platform_share.created", result="success",
                project_id=project.host_project_id, task_id=share.task_id,
                actor_username=actor.username, actor_name=actor.display_name,
                actor_type="user", initiated_by_user_id=actor.id,
                initiated_by_username=actor.username,
                metadata_json=json.dumps({"share_id": share.id}),
            ))
    return {"id": share.id, "url": f"{origin.rstrip('/')}/share/{token}",
            "status": share.status, "mode": share.mode, "title": share.title,
            "expires_at": expiry}


async def list_own_platform_shares(call: GatewayCall,
                                   project_id: str = None,
                                   task_id: str = None):
    actor, _ = await IdentityService(call.database).session_user(call.tokens.get(COOKIE_NAME))
    if actor.status != "active":
        raise GatewayError('forbidden', 'Account unavailable')
    async with call.database.session() as session:
        rows = (await session.scalars(select(PlatformShare).where(
            PlatformShare.created_by_user_id == actor.id,
            PlatformShare.project_id == project_id,
            PlatformShare.task_id == task_id,
        ).order_by(PlatformShare.created_at.desc(), PlatformShare.id.desc()).limit(100))).all()
    now = datetime.now(timezone.utc)
    return {"shares": [{
        "id": share.id, "title": share.title, "mode": share.mode,
        "status": ("revoked" if share.revoked_at is not None
                   else "expired" if share.expires_at is not None and _utc(share.expires_at) <= now
                   else share.status),
        "created_at": share.created_at, "expires_at": share.expires_at,
    } for share in rows]}


async def revoke_platform_share(call: GatewayCall, share_id: str):
    auth_token = call.tokens.get(COOKIE_NAME)
    actor, _ = await IdentityService(call.database).session_user(auth_token)
    _check_csrf(call, auth_token)
    async with call.database.session() as session:
        async with session.begin():
            share = await session.get(PlatformShare, share_id)
            if share is None:
                raise GatewayError('not_found', 'Share unavailable')
            admin = await IdentityService.super_admin_in_session(session, actor.id)
            if actor.id != share.created_by_user_id and not admin:
                raise GatewayError('forbidden', 'Share management unavailable')
            if share.revoked_at is None:
                project = await session.get(PlatformProject, share.project_id)
                share.status = "revoked"
                share.revoked_at = datetime.now(timezone.utc)
                await session.execute(update(PlatformShareSession).where(
                    PlatformShareSession.share_id == share.id,
                    PlatformShareSession.revoked_at.is_(None),
                ).values(revoked_at=share.revoked_at))
                session.add(AuditEvent(
                    id=str(uuid4()), user_id=actor.id, device_id=share.device_id,
                    action="platform_share.revoked", result="success",
                    project_id=project.host_project_id if project else None,
                    task_id=share.task_id,
                    actor_username=actor.username, actor_name=actor.display_name,
                    actor_type="user", initiated_by_user_id=actor.id,
                    initiated_by_username=actor.username,
                    metadata_json=json.dumps({"share_id": share.id}),
                ))


async def public_share_meta(call: GatewayCall, token: str):
    share = await _live_share(call, token)
    return {"title": share.title, "mode": share.mode,
            "has_password": share.password_hash is not None, "status": "active"}


async def unlock_public_share(call: GatewayCall, token: str, body: UnlockShareInput):
    share = await _live_share(call, token)
    client_ip = call.peer.host if call.peer else 'unknown'
    await call.identity_rate_limiter.check(f'share:{share.id}', client_ip)
    if share.password_hash is not None:
        try:
            verified = await asyncio.to_thread(_hasher.verify, share.password_hash, body.password)
        except VerificationError:
            verified = False
        if not verified:
            raise GatewayError('forbidden', 'Invalid share password')
    session_token = secrets.token_urlsafe(32)
    expiry = min(datetime.now(timezone.utc) + timedelta(hours=1),
                 _utc(share.expires_at) if share.expires_at else datetime.now(timezone.utc) + timedelta(hours=1))
    async with call.database.session() as session:
        async with session.begin():
            current = await session.get(PlatformShare, share.id)
            if (current is None or current.revoked_at is not None
                    or current.status != "active"):
                raise GatewayError('not_found', 'Share unavailable')
            session.add(PlatformShareSession(
                id=str(uuid4()), share_id=share.id,
                session_token_hash=_digest(session_token), expires_at=expiry,
            ))

    response = JsonValue({'unlocked': True, 'csrf_token': _share_csrf(session_token)})
    response.grants.append(CredentialGrant(SHARE_SESSION_COOKIE, session_token, lifetime=3600))
    response.headers["Cache-Control"] = "no-store"
    return response


async def public_share_session(call: GatewayCall, token: str):
    share, _ = await _authorized_visitor(call, token, touch=True)
    return {"share_id": share.id, "mode": share.mode, "task_id": share.task_id,
            "csrf_token": _share_csrf(call.tokens[SHARE_SESSION_COOKIE])}


async def public_share_task(call: GatewayCall, token: str):
    return await _proxy_share_request(call, token, '/api/platform-share/task')


async def public_share_execution_report(call: GatewayCall, token: str):
    return await _proxy_share_request(call, token, '/api/platform-share/execution-report')


async def public_share_host_status(call: GatewayCall, token: str):

    share, _ = await _authorized_visitor(call, token)
    connections = call.control_connections
    connected = connections.is_online(share.device_id)
    return JsonValue({'connected': connected, 'daemon_health': connections.daemon_health(share.device_id) if connected else None}, headers={'Cache-Control': 'no-store'})


async def public_share_history(call: GatewayCall, token: str):
    return await _proxy_share_request(call, token, '/api/platform-share/history')


async def public_share_history_page(call: GatewayCall, token: str, offset: int):
    if not 0 <= offset <= 999999:
        raise GatewayError('not_found', 'History page unavailable')
    return await _proxy_share_request(call, token, f'/api/platform-share/history/{offset}')


async def public_share_events(call: GatewayCall, token: str, message_id: str, cursor: int):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", message_id) or not 0 <= cursor <= 999999999:
        raise GatewayError('not_found', 'Message events unavailable')
    return await _proxy_share_request(call, token, f'/api/platform-share/events/{message_id}/{cursor}')


async def public_share_artifacts(call: GatewayCall, token: str):
    return await _proxy_share_request(call, token, '/api/platform-share/artifacts')


async def public_share_reviews(call: GatewayCall, token: str):
    return await _proxy_share_request(call, token, '/api/platform-share/reviews')


async def public_share_interventions(call: GatewayCall, token: str):
    return await _proxy_share_request(call, token, '/api/platform-share/interventions', interactive_read=True)


async def public_share_artifact_content(call: GatewayCall, token: str, artifact_id: str):
    if not re.fullmatch(r"[0-9a-f]{64}", artifact_id):
        raise GatewayError('not_found', 'Artifact unavailable')
    return await _proxy_share_request(call, token, f'/api/platform-share/artifacts/{artifact_id}/content')


async def public_share_artifact_preview(call: GatewayCall, token: str, artifact_id: str):
    if not re.fullmatch(r"[0-9a-f]{64}", artifact_id):
        raise GatewayError('not_found', 'Artifact unavailable')
    return await _proxy_share_request(call, token, f'/api/platform-share/artifacts/{artifact_id}/preview')


async def public_share_upload(call: GatewayCall, token: str):
    async with call.share_upload_slots:
        return await _proxy_share_request(call, token, '/api/platform-share/uploads', write=True, body_kind='upload')


async def public_share_upload_content(call: GatewayCall, token: str, filename: str):
    if not re.fullmatch(r"t[0-9a-f]{24}-[0-9a-f]{32}\.[a-z0-9]{1,10}", filename):
        raise GatewayError('not_found', 'Attachment unavailable')
    response = await _proxy_share_request(call, token, f'/api/platform-share/uploads/{filename}')
    response.headers["Content-Security-Policy"] = "sandbox"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


async def public_share_git_read(call: GatewayCall, token: str, action: str, encoded: str):
    if action not in {"repositories", "history", "changes", "diff", "blame", "remotes", "browse", "preview", "content"} or not re.fullmatch(r"[0-9a-f]{2,16384}", encoded):
        raise GatewayError('not_found', 'Git view unavailable')
    return await _proxy_share_request(call, token, f'/api/platform-share/git/read/{action}/{encoded}')


async def public_share_git_workspace(call: GatewayCall, token: str):
    return await _proxy_share_request(call, token, '/api/platform-share/git/workspace')


async def public_share_git_status(call: GatewayCall, token: str, tree_id: str):
    if not re.fullmatch(r"[0-9a-f]{24}", tree_id):
        raise GatewayError('not_found', 'Git worktree unavailable')
    return await _proxy_share_request(call, token, f'/api/platform-share/git/worktrees/{tree_id}/status')


async def public_share_git_branches(call: GatewayCall, token: str, tree_id: str):
    if not re.fullmatch(r"[0-9a-f]{24}", tree_id):
        raise GatewayError('not_found', 'Git worktree unavailable')
    return await _proxy_share_request(call, token, f'/api/platform-share/git/worktrees/{tree_id}/branches')


async def public_share_git_commit(call: GatewayCall, token: str, tree_id: str):
    if not re.fullmatch(r"[0-9a-f]{24}", tree_id):
        raise GatewayError('not_found', 'Git worktree unavailable')
    return await _proxy_share_request(call, token, f'/api/platform-share/git/worktrees/{tree_id}/commit', write=True, body_kind='git_commit')


async def public_share_git_switch(call: GatewayCall, token: str, tree_id: str):
    if not re.fullmatch(r"[0-9a-f]{24}", tree_id):
        raise GatewayError('not_found', 'Git worktree unavailable')
    return await _proxy_share_request(call, token, f'/api/platform-share/git/worktrees/{tree_id}/switch', write=True, body_kind='git_switch')


async def public_share_git_fetch(call: GatewayCall, token: str, tree_id: str):
    if not re.fullmatch(r"[0-9a-f]{24}", tree_id):
        raise GatewayError('not_found', 'Git worktree unavailable')
    return await _proxy_share_request(call, token, f'/api/platform-share/git/worktrees/{tree_id}/fetch', write=True)


async def public_share_git_create_branch(call: GatewayCall, token: str, tree_id: str):
    if not re.fullmatch(r"[0-9a-f]{24}", tree_id):
        raise GatewayError('not_found', 'Git worktree unavailable')
    return await _proxy_share_request(call, token, f'/api/platform-share/git/worktrees/{tree_id}/branches', write=True, body_kind='git_branch_create')


async def public_share_git_delete_branch(call: GatewayCall, token: str, tree_id: str):
    if not re.fullmatch(r"[0-9a-f]{24}", tree_id):
        raise GatewayError('not_found', 'Git worktree unavailable')
    return await _proxy_share_request(call, token, f'/api/platform-share/git/worktrees/{tree_id}/branches/delete', write=True, body_kind='git_branch_delete')


async def public_share_git_sync(call: GatewayCall, token: str, tree_id: str, action: str):
    if not re.fullmatch(r"[0-9a-f]{24}", tree_id) or action not in {"pull", "push"}:
        raise GatewayError('not_found', 'Git operation unavailable')
    return await _proxy_share_request(call, token, f'/api/platform-share/git/worktrees/{tree_id}/{action}', write=True, body_kind='git_sync')


async def public_share_step_message(call: GatewayCall, token: str, step_key: str):
    return await _proxy_share_step(call, token, step_key, 'message')


async def public_share_step_resume(call: GatewayCall, token: str, step_key: str):
    return await _proxy_share_step(call, token, step_key, 'resume')


async def public_share_step_cancel(call: GatewayCall, token: str, step_key: str):
    return await _proxy_share_step(call, token, step_key, 'cancel')


async def public_share_review_decision(call: GatewayCall, token: str,
                                       step_key: str, decision: str):
    if (not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", step_key)
            or decision not in {"approve", "reject", "force_approve", "terminate", "complete_task"}):
        raise GatewayError('not_found', 'Review decision unavailable')
    return await _proxy_share_request(call, token, f'/api/platform-share/steps/{step_key}/review/{decision}', write=True, body_kind='review')


async def public_share_intervention_response(call: GatewayCall, token: str,
                                             interaction_id: str):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", interaction_id):
        raise GatewayError('not_found', 'Interaction unavailable')
    return await _proxy_share_request(call, token, f'/api/platform-share/interventions/{interaction_id}/respond', write=True, body_kind='interaction')
