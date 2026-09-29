"""Gateway-owned public share credentials and visitor sessions."""

import asyncio
import hashlib
import hmac
import json
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Literal
from urllib.parse import urlsplit
from uuid import uuid4

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select, update

from .identity import COOKIE_NAME, IdentityService
from .identity_api import _check_csrf
from .models import (AdminAssignment, AuditEvent, CapabilityAssignment, Device,
                     PlatformProject, PlatformShare, PlatformShareSession)
from .project_access_api import effective_project_access

router = APIRouter(prefix="/api")
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


def _share_csrf(session_token: str) -> str:
    return hashlib.sha256(f"share-csrf:{session_token}".encode()).hexdigest()


def _check_share_csrf(request: Request) -> None:
    session_token = request.cookies.get(SHARE_SESSION_COOKIE, "")
    provided = request.headers.get("x-share-csrf", "")
    if not provided or not hmac.compare_digest(provided, _share_csrf(session_token)):
        raise HTTPException(status_code=403, detail="Share CSRF token required")


async def _bounded_share_json(request: Request):
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 262144:
            raise HTTPException(status_code=413, detail="Share message too large")
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=422, detail="Invalid share message") from exc


async def _share_message_body(request: Request) -> bytes:
    try:
        body = ShareMessageInput.model_validate(await _bounded_share_json(request))
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail="Invalid share message") from exc
    if not body.content.strip():
        raise HTTPException(status_code=422, detail="Share message required")
    return json.dumps({"content": body.content}, separators=(",", ":")).encode()


async def _share_review_body(request: Request) -> bytes:
    try:
        body = ShareReviewInput.model_validate(await _bounded_share_json(request))
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail="Invalid review decision") from exc
    return json.dumps({"review_run_id": body.review_run_id, "comment": body.comment},
                      separators=(",", ":")).encode()


async def _share_interaction_body(request: Request) -> bytes:
    try:
        body = ShareInteractionInput.model_validate(await _bounded_share_json(request))
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail="Invalid interaction response") from exc
    return json.dumps({"data": body.data}, separators=(",", ":")).encode()


async def can_create_platform_share(session, user_id: str, project: PlatformProject) -> bool:
    admin = await session.scalar(select(AdminAssignment.id).where(
        AdminAssignment.user_id == user_id,
        AdminAssignment.role == "super_admin",
        AdminAssignment.revoked_at.is_(None),
    ))
    if admin is not None:
        return True
    access = await effective_project_access(session, user_id, project.id)
    if access != "edit":
        return False
    rules = (await session.scalars(select(CapabilityAssignment).where(
        CapabilityAssignment.user_id == user_id,
        CapabilityAssignment.capability == "share.create",
        CapabilityAssignment.revoked_at.is_(None),
    ))).all()
    applicable = [rule for rule in rules if rule.scope_type == "global"
                  or (rule.scope_type == "device" and rule.scope_id == project.device_id)
                  or (rule.scope_type == "project" and rule.scope_id == project.id)]
    return (any(rule.effect == "allow" for rule in applicable)
            and not any(rule.effect == "deny" for rule in applicable))


async def _live_share(request: Request, token: str) -> PlatformShare:
    if len(token) > 128:
        raise HTTPException(status_code=404, detail="Share unavailable")
    async with request.app.state.database.session() as session:
        share = await session.scalar(select(PlatformShare).where(
            PlatformShare.token_hash == _digest(token),
        ))
        if share is None or share.revoked_at is not None or share.status == "revoked":
            raise HTTPException(status_code=404, detail="Share unavailable")
        project = await session.get(PlatformProject, share.project_id)
        device = await session.get(Device, share.device_id)
    if share.expires_at is not None and _utc(share.expires_at) <= datetime.now(timezone.utc):
        raise HTTPException(status_code=404, detail="Share expired")
    if share.status == "paused":
        raise HTTPException(status_code=503, detail="Share paused")
    if share.status != "active":
        raise HTTPException(status_code=404, detail="Share unavailable")
    if (project is None or project.status != "active"
            or project.access_mode != "remote_published"
            or project.device_id != share.device_id):
        raise HTTPException(status_code=503, detail="Share project unavailable")
    if device is None or device.status != "active":
        raise HTTPException(status_code=503, detail="Share paused")
    return share


async def _authorized_visitor(request: Request, token: str, *, touch: bool = False):
    share = await _live_share(request, token)
    session_token = request.cookies.get(SHARE_SESSION_COOKIE)
    if not session_token:
        raise HTTPException(status_code=401, detail="Share session required")
    async with request.app.state.database.session() as session:
        async with session.begin():
            visit = await session.scalar(select(PlatformShareSession).where(
                PlatformShareSession.session_token_hash == _digest(session_token),
                PlatformShareSession.share_id == share.id,
                PlatformShareSession.revoked_at.is_(None),
            ))
            project = await session.get(PlatformProject, share.project_id)
            if visit is None or _utc(visit.expires_at) <= datetime.now(timezone.utc):
                raise HTTPException(status_code=401, detail="Share session expired")
            if project is None or project.device_id != share.device_id:
                raise HTTPException(status_code=503, detail="Share project unavailable")
            if touch:
                visit.last_seen_at = datetime.now(timezone.utc)
    return share, project


@router.post("/platform-shares", status_code=201)
async def create_platform_share(request: Request, body: CreateShareInput):
    origin = request.app.state.settings.public_origin
    if origin is None or urlsplit(origin).scheme != "https":
        raise HTTPException(status_code=503, detail="Public Gateway origin unavailable")
    auth_token = request.cookies.get(COOKIE_NAME)
    actor, _ = await IdentityService(request.app.state.database).session_user(auth_token)
    _check_csrf(request, auth_token)
    if actor.status != "active" or actor.must_change_password:
        raise HTTPException(status_code=403, detail="Account unavailable")
    if body.expires_at is not None:
        expiry = _utc(body.expires_at)
        if not datetime.now(timezone.utc) < expiry <= datetime.now(timezone.utc) + timedelta(days=90):
            raise HTTPException(status_code=422, detail="Invalid share expiration")
    else:
        expiry = None
    password_hash = (await asyncio.to_thread(_hasher.hash, body.password)) if body.password else None
    token = secrets.token_urlsafe(32)
    async with request.app.state.database.session() as session:
        async with session.begin():
            project = await session.get(PlatformProject, body.project_id)
            device = await session.get(Device, project.device_id) if project else None
            if (project is None or project.status != "active"
                    or project.access_mode != "remote_published"
                    or device is None or device.status != "active"):
                raise HTTPException(status_code=404, detail="Published project unavailable")
            if not await can_create_platform_share(session, actor.id, project):
                raise HTTPException(status_code=403, detail="Share creation unavailable")
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
            ))
    return {"id": share.id, "url": f"{origin.rstrip('/')}/share/{token}",
            "status": share.status, "mode": share.mode, "title": share.title,
            "expires_at": expiry}


@router.get("/platform-shares")
async def list_own_platform_shares(request: Request,
                                   project_id: str = Query(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"),
                                   task_id: str = Query(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")):
    actor, _ = await IdentityService(request.app.state.database).session_user(
        request.cookies.get(COOKIE_NAME),
    )
    if actor.status != "active" or actor.must_change_password:
        raise HTTPException(status_code=403, detail="Account unavailable")
    async with request.app.state.database.session() as session:
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


@router.post("/platform-shares/{share_id}/revoke", status_code=204)
async def revoke_platform_share(request: Request, share_id: str):
    auth_token = request.cookies.get(COOKIE_NAME)
    actor, _ = await IdentityService(request.app.state.database).session_user(auth_token)
    _check_csrf(request, auth_token)
    async with request.app.state.database.session() as session:
        async with session.begin():
            share = await session.get(PlatformShare, share_id)
            if share is None:
                raise HTTPException(status_code=404, detail="Share unavailable")
            admin = await session.scalar(select(AdminAssignment.id).where(
                AdminAssignment.user_id == actor.id,
                AdminAssignment.role == "super_admin",
                AdminAssignment.revoked_at.is_(None),
            ))
            if actor.id != share.created_by_user_id and admin is None:
                raise HTTPException(status_code=403, detail="Share management unavailable")
            if share.revoked_at is None:
                share.status = "revoked"
                share.revoked_at = datetime.now(timezone.utc)
                await session.execute(update(PlatformShareSession).where(
                    PlatformShareSession.share_id == share.id,
                    PlatformShareSession.revoked_at.is_(None),
                ).values(revoked_at=share.revoked_at))
                session.add(AuditEvent(
                    id=str(uuid4()), user_id=actor.id, device_id=share.device_id,
                    action="platform_share.revoked", result="success",
                ))


@router.get("/public/shares/{token}/meta")
async def public_share_meta(request: Request, token: str):
    share = await _live_share(request, token)
    return {"title": share.title, "mode": share.mode,
            "has_password": share.password_hash is not None, "status": "active"}


@router.post("/public/shares/{token}/unlock")
async def unlock_public_share(request: Request, token: str, body: UnlockShareInput):
    share = await _live_share(request, token)
    client_ip = request.client.host if request.client else "unknown"
    await request.app.state.identity_rate_limiter.check(f"share:{share.id}", client_ip)
    if share.password_hash is not None:
        try:
            verified = await asyncio.to_thread(_hasher.verify, share.password_hash, body.password)
        except VerificationError:
            verified = False
        if not verified:
            raise HTTPException(status_code=403, detail="Invalid share password")
    session_token = secrets.token_urlsafe(32)
    expiry = min(datetime.now(timezone.utc) + timedelta(hours=1),
                 _utc(share.expires_at) if share.expires_at else datetime.now(timezone.utc) + timedelta(hours=1))
    async with request.app.state.database.session() as session:
        async with session.begin():
            current = await session.get(PlatformShare, share.id)
            if (current is None or current.revoked_at is not None
                    or current.status != "active"):
                raise HTTPException(status_code=404, detail="Share unavailable")
            session.add(PlatformShareSession(
                id=str(uuid4()), share_id=share.id,
                session_token_hash=_digest(session_token), expires_at=expiry,
            ))
    from fastapi.responses import JSONResponse
    response = JSONResponse({"unlocked": True, "csrf_token": _share_csrf(session_token)})
    response.set_cookie(SHARE_SESSION_COOKIE, session_token, max_age=3600,
                        secure=True, httponly=True, samesite="lax", path="/")
    response.headers["Cache-Control"] = "no-store"
    return response


@router.get("/public/shares/{token}/session")
async def public_share_session(request: Request, token: str):
    share, _ = await _authorized_visitor(request, token, touch=True)
    return {"share_id": share.id, "mode": share.mode, "task_id": share.task_id,
            "csrf_token": _share_csrf(request.cookies[SHARE_SESSION_COOKIE])}


@router.get("/public/shares/{token}/task")
async def public_share_task(request: Request, token: str):
    return await _proxy_share_request(request, token, "/api/platform-share/task")


@router.get("/public/shares/{token}/host-status")
async def public_share_host_status(request: Request, token: str):
    from fastapi.responses import JSONResponse
    share, _ = await _authorized_visitor(request, token)
    connections = request.app.state.control_connections
    connected = connections.is_online(share.device_id)
    return JSONResponse(
        {"connected": connected,
         "daemon_health": connections.daemon_health(share.device_id) if connected else None},
        headers={"Cache-Control": "no-store"},
    )


@router.get("/public/shares/{token}/history")
async def public_share_history(request: Request, token: str):
    return await _proxy_share_request(request, token, "/api/platform-share/history")


@router.get("/public/shares/{token}/history/{offset}")
async def public_share_history_page(request: Request, token: str, offset: int):
    if not 0 <= offset <= 999999:
        raise HTTPException(status_code=404, detail="History page unavailable")
    return await _proxy_share_request(request, token, f"/api/platform-share/history/{offset}")


@router.get("/public/shares/{token}/events/{message_id}/{cursor}")
async def public_share_events(request: Request, token: str, message_id: str, cursor: int):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", message_id) or not 0 <= cursor <= 999999999:
        raise HTTPException(status_code=404, detail="Message events unavailable")
    return await _proxy_share_request(
        request, token, f"/api/platform-share/events/{message_id}/{cursor}",
    )


@router.get("/public/shares/{token}/artifacts")
async def public_share_artifacts(request: Request, token: str):
    return await _proxy_share_request(request, token, "/api/platform-share/artifacts")


@router.get("/public/shares/{token}/reviews")
async def public_share_reviews(request: Request, token: str):
    return await _proxy_share_request(request, token, "/api/platform-share/reviews")


@router.get("/public/shares/{token}/interventions")
async def public_share_interventions(request: Request, token: str):
    return await _proxy_share_request(
        request, token, "/api/platform-share/interventions", interactive_read=True,
    )


@router.get("/public/shares/{token}/artifacts/{artifact_id}/content")
async def public_share_artifact_content(request: Request, token: str, artifact_id: str):
    if not re.fullmatch(r"[0-9a-f]{64}", artifact_id):
        raise HTTPException(status_code=404, detail="Artifact unavailable")
    return await _proxy_share_request(
        request, token, f"/api/platform-share/artifacts/{artifact_id}/content",
    )


@router.get("/public/shares/{token}/artifacts/{artifact_id}/preview")
async def public_share_artifact_preview(request: Request, token: str, artifact_id: str):
    if not re.fullmatch(r"[0-9a-f]{64}", artifact_id):
        raise HTTPException(status_code=404, detail="Artifact unavailable")
    return await _proxy_share_request(
        request, token, f"/api/platform-share/artifacts/{artifact_id}/preview",
    )


@router.post("/public/shares/{token}/steps/{step_key}/message")
async def public_share_step_message(request: Request, token: str, step_key: str):
    return await _proxy_share_step(request, token, step_key, "message")


@router.post("/public/shares/{token}/steps/{step_key}/resume")
async def public_share_step_resume(request: Request, token: str, step_key: str):
    return await _proxy_share_step(request, token, step_key, "resume")


@router.post("/public/shares/{token}/steps/{step_key}/cancel")
async def public_share_step_cancel(request: Request, token: str, step_key: str):
    return await _proxy_share_step(request, token, step_key, "cancel")


async def _proxy_share_step(request: Request, token: str, step_key: str, action: str):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", step_key):
        raise HTTPException(status_code=404, detail="Step unavailable")
    return await _proxy_share_request(
        request, token, f"/api/platform-share/steps/{step_key}/{action}",
        write=True, body_kind="message" if action != "cancel" else None,
    )


@router.post("/public/shares/{token}/steps/{step_key}/review/{decision}")
async def public_share_review_decision(request: Request, token: str,
                                       step_key: str, decision: str):
    if (not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", step_key)
            or decision not in {"approve", "reject", "force_approve", "terminate", "complete_task"}):
        raise HTTPException(status_code=404, detail="Review decision unavailable")
    return await _proxy_share_request(
        request, token, f"/api/platform-share/steps/{step_key}/review/{decision}",
        write=True, body_kind="review",
    )


@router.post("/public/shares/{token}/interventions/{interaction_id}/respond")
async def public_share_intervention_response(request: Request, token: str,
                                             interaction_id: str):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", interaction_id):
        raise HTTPException(status_code=404, detail="Interaction unavailable")
    return await _proxy_share_request(
        request, token,
        f"/api/platform-share/interventions/{interaction_id}/respond",
        write=True, body_kind="interaction",
    )


async def _proxy_share_request(request: Request, token: str, target_path: str,
                               *, write: bool = False,
                               interactive_read: bool = False,
                               body_kind: Literal["message", "review", "interaction"] | None = None):
    share, project = await _authorized_visitor(request, token, touch=True)
    if write or interactive_read:
        if share.mode != "interactive":
            raise HTTPException(status_code=403, detail="Share is read-only")
    if write:
        _check_share_csrf(request)
    share_body = (await _share_message_body(request) if body_kind == "message"
                  else await _share_review_body(request) if body_kind == "review"
                  else await _share_interaction_body(request) if body_kind == "interaction"
                  else b"" if write else None)
    connections = request.app.state.control_connections
    if not connections.is_online(share.device_id):
        raise HTTPException(status_code=503, detail="Shared device offline")

    async def authorize_stream():
        current, current_project = await _authorized_visitor(request, token)
        if (current.id != share.id or current.device_id != share.device_id
                or current_project.host_project_id != project.host_project_id
                or current.mode != share.mode):
            raise HTTPException(status_code=403, detail="Share changed")

    ticket = request.app.state.gateway_signer.sign_platform_share_ticket(
        gateway_id=request.app.state.settings.gateway_id,
        device_id=share.device_id, share_id=share.id,
        project_id=share.project_id, host_project_id=project.host_project_id,
        task_id=share.task_id, mode=share.mode,
    )
    try:
        connection = await connections.request_data(share.device_id)
        response = await connection.proxy_http(
            request, share_ticket=ticket,
            target_path=target_path,
            authorization_check=authorize_stream,
            **({"share_body": share_body} if write else {}),
        )
        response.headers["Cache-Control"] = "no-store"
        return response
    except (ConnectionError, asyncio.TimeoutError) as exc:
        raise HTTPException(status_code=503, detail="Shared device unavailable") from exc
