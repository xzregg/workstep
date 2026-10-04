import hashlib

import asyncio

import time

from datetime import datetime, timezone

from urllib.parse import parse_qs

from fastapi import APIRouter, HTTPException, Request, WebSocket

from fastapi.responses import RedirectResponse

from sqlalchemy import select

from sqlalchemy.exc import IntegrityError

from workstep_gateway_protocol import project_http_route_allowed

from gateway.services.providers_api import compiled_provider_access

from gateway.services.capabilities import compiled_device_policy

from gateway.services.identity import COOKIE_NAME, IdentityService

from gateway.models import Device, PlatformProject, UsedDeviceAccessTicket, User, UserDevice

from gateway.services.project_access_api import effective_project_access, project_grant_rows

from gateway.services.platform_shares import can_create_platform_share


"""One-time, host-bound entry into a managed PC's remote workspace."""


def _device_host(request: Request) -> str:
    origin = request.app.state.settings.public_origin
    if origin is None:
        raise HTTPException(status_code=503, detail="Public Gateway origin is not configured")
    host = request.headers.get("host", "").lower()
    if not request.app.state.settings.is_device_authority(host):
        raise HTTPException(status_code=403, detail="Device host required")
    return host


async def _active_access(request: Request, user_id: str, device_id: str) -> None:
    async with request.app.state.database.session() as session:
        user = await session.get(User, user_id)
        device = await session.get(Device, device_id)
        assignment = await session.scalar(select(UserDevice).where(
            UserDevice.device_id == device_id, UserDevice.user_id == user_id,
            UserDevice.revoked_at.is_(None),
        ))
    if (not user or user.status != "active" or user.must_change_password
            or not device or device.status != "active" or not assignment):
        raise HTTPException(status_code=403, detail="Device access denied")
    if not request.app.state.control_connections.is_online(device_id):
        raise HTTPException(status_code=409, detail="Device is offline")


async def _active_project_access(request: Request, user_id: str, device_id: str,
                                 project_id: str, host_project_id: str) -> str:
    async with request.app.state.database.session() as session:
        user = await session.get(User, user_id)
        device = await session.get(Device, device_id)
        project = await session.get(PlatformProject, project_id)
        level = await effective_project_access(session, user_id, project_id)
    if (not user or user.status != "active" or user.must_change_password
            or not device or device.status != "active" or not project
            or project.device_id != device_id or project.host_project_id != host_project_id
            or project.status != "active" or project.access_mode != "remote_published"
            or level is None):
        raise HTTPException(status_code=403, detail="Project access denied")
    if not request.app.state.control_connections.is_online(device_id):
        raise HTTPException(status_code=409, detail="Device is offline")
    return level


async def _project_task_create_allowed(request: Request, device_id: str,
                                       user_id: str, host_project_id: str) -> bool:
    _, broad, _, allowed, denied = await compiled_device_policy(
        request.app.state.database, device_id, user_id,
    )
    return (broad or host_project_id in allowed) and host_project_id not in denied


async def _remote_identity(request: Request):
    host = _device_host(request)
    user, auth_session = await IdentityService(request.app.state.database).session_user(
        request.cookies.get(COOKIE_NAME), allow_device_session=True,
    )
    device_id = auth_session.device_id
    if not device_id or host != request.app.state.settings.device_authority(device_id):
        raise HTTPException(status_code=403, detail="Device session mismatch")
    if auth_session.project_id:
        async with request.app.state.database.session() as session:
            project = await session.get(PlatformProject, auth_session.project_id)
        if project is None:
            raise HTTPException(status_code=403, detail="Project unavailable")
        current_level = await _active_project_access(request, user.id, device_id,
                                                     project.id, project.host_project_id)
        if current_level == "read":
            auth_session.project_access_level = "read"
        host_project_id = project.host_project_id
    else:
        await _active_access(request, user.id, device_id)
        host_project_id = None
    return user, device_id, auth_session, host_project_id


async def _check_provider_grants(request, device_id: str, user_id: str, provider_ids: list[str]):
    current, _ = await compiled_provider_access(request.app.state.database, device_id, user_id)
    if set(provider_ids) - set(current):
        raise HTTPException(status_code=403, detail='Provider access revoked')


async def proxy_remote_request(request: Request):
    user, device_id, auth_session, host_project_id = await _remote_identity(request)
    provider_ids, _ = await compiled_provider_access(request.app.state.database, device_id, user.id)
    provider_grant_expires_at = int(time.time()) + 300
    task_create = False
    if auth_session.project_id:
        if request.method == "POST" and request.url.path in ("/api/task/create", "/api/task/copy"):
            task_create = await _project_task_create_allowed(
                request, device_id, user.id, host_project_id,
            )
        if not project_http_route_allowed(
                request.method, request.url.path,
                list(request.query_params.multi_items()), host_project_id,
                access_level=auth_session.project_access_level,
                task_create=task_create):
            raise HTTPException(status_code=403, detail="Project proxy scope unavailable")
    try:
        connection = await request.app.state.control_connections.request_data(device_id)
        if auth_session.project_id:
            async def authorize_stream():
                await _check_provider_grants(request, device_id, user.id, provider_ids)
                current_level = await _active_project_access(
                    request, user.id, device_id, auth_session.project_id,
                    host_project_id,
                )
                if auth_session.project_access_level == "edit" and current_level != "edit":
                    raise HTTPException(status_code=403, detail="Project edit access revoked")
                if task_create:
                    if not await _project_task_create_allowed(
                            request, device_id, user.id, host_project_id):
                        raise HTTPException(status_code=403,
                                            detail="Task creation capability revoked")

            return await connection.proxy_http(
                request, user_id=user.id, username=user.username,
                display_name=user.display_name, provider_ids=provider_ids,
                provider_grant_expires_at=provider_grant_expires_at,
                project_id=host_project_id,
                access_level=auth_session.project_access_level,
                task_create=task_create,
                authorization_check=authorize_stream,
            )
        async def authorize_pc_stream():
            await _check_provider_grants(request, device_id, user.id, provider_ids)
            await _active_access(request, user.id, device_id)

        return await connection.proxy_http(
            request, authorization_check=authorize_pc_stream, user_id=user.id, username=user.username,
            display_name=user.display_name, provider_ids=provider_ids,
            provider_grant_expires_at=provider_grant_expires_at,
        )
    except (ConnectionError, asyncio.TimeoutError) as exc:
        raise HTTPException(status_code=502, detail="Device data connection unavailable") from exc



async def redeem_device_ticket(request: Request):
    host = _device_host(request)
    if request.headers.get("content-type", "").split(";")[0] != "application/x-www-form-urlencoded":
        raise HTTPException(status_code=415, detail="Form data required")
    body = await request.body()
    if len(body) > 16384:
        raise HTTPException(status_code=413, detail="Ticket too large")
    try:
        fields = parse_qs(body.decode("ascii"), strict_parsing=True)
        ticket = fields["ticket"]
        if len(ticket) != 1:
            raise ValueError("Ticket count")
        claims = request.app.state.gateway_signer.verify_access_ticket(
            ticket[0], gateway_id=request.app.state.settings.gateway_id, audience=host,
        )
    except (ValueError, KeyError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=403, detail="Invalid device access ticket") from exc
    device_id, user_id = claims["device_id"], claims["user_id"]
    if host != request.app.state.settings.device_authority(device_id):
        raise HTTPException(status_code=403, detail="Ticket device mismatch")
    if claims["kind"] == "project.access":
        current_level = await _active_project_access(
            request, user_id, device_id, claims["project_id"],
            claims["host_project_id"],
        )
    else:
        await _active_access(request, user_id, device_id)
    auth_session, token = IdentityService._create_session(user_id)
    auth_session.device_id = device_id
    if claims["kind"] == "project.access":
        auth_session.project_id = claims["project_id"]
        auth_session.project_access_level = (
            "read" if "read" in (claims["access_level"], current_level) else "edit"
        )
    auth_session.expires_at = datetime.fromtimestamp(
        min(claims["exp"] + 3600, int(auth_session.expires_at.timestamp())), timezone.utc,
    )
    try:
        async with request.app.state.database.session() as session:
            async with session.begin():
                session.add(UsedDeviceAccessTicket(
                    jti_hash=hashlib.sha256(claims["jti"].encode()).hexdigest(),
                    user_id=user_id, device_id=device_id,
                    expires_at=datetime.fromtimestamp(claims["exp"], timezone.utc),
                ))
                session.add(auth_session)
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="Ticket already used") from exc
    response = RedirectResponse("/", status_code=303)
    response.set_cookie(COOKIE_NAME, token, max_age=3600, secure=request.app.state.settings.cookie_secure,
                        httponly=True, samesite="lax", path="/")
    response.headers["Cache-Control"] = "no-store"
    return response



async def remote_session(request: Request):
    user, device_id, auth_session, host_project_id = await _remote_identity(request)
    task_create = (auth_session.project_access_level == "edit"
                   and host_project_id is not None
                   and await _project_task_create_allowed(
                       request, device_id, user.id, host_project_id))
    async with request.app.state.database.session() as session:
        device = await session.get(Device, device_id)
        project = await session.get(PlatformProject, auth_session.project_id) if auth_session.project_id else None
        share_create = (await can_create_platform_share(session, user.id, project)
                        if project is not None else False)
    if device is None:
        raise HTTPException(status_code=403, detail="Device access denied")
    return {"user_id": user.id, "username": user.display_name,
            "device_id": device_id, "device_name": device.name,
            "project_id": auth_session.project_id,
            "host_project_id": host_project_id,
            "access_level": auth_session.project_access_level,
            "task_create": task_create,
            "share_create": share_create,
            "can_manage_project_access": await IdentityService(
                request.app.state.database).is_super_admin(user.id),
            "online": True,
            "gateway_url": request.app.state.settings.public_origin + "/devices"}



async def remote_project_grants(request: Request):
    _, _, auth_session, _ = await _remote_identity(request)
    if auth_session.project_id is None:
        raise HTTPException(status_code=403, detail="Project session required")
    async with request.app.state.database.session() as session:
        rows = await project_grant_rows(session, auth_session.project_id)
    return {"grants": [{key: row[key] for key in (
        "subject_type", "subject_id", "subject_name", "access_level",
    )} for row in rows]}



async def proxy_remote_websocket(ws: WebSocket, path: str):
    try:
        user, device_id, auth_session, host_project_id = await _remote_identity(ws)
        provider_ids, _ = await compiled_provider_access(ws.app.state.database, device_id, user.id)
        provider_grant_expires_at = int(time.time()) + 300
        if auth_session.project_id:
            if ws.url.path != "/ws":
                raise HTTPException(status_code=403, detail="Project proxy scope unavailable")
            project_id = auth_session.project_id
            access_level = auth_session.project_access_level

            async def authorize_stream():
                await _check_provider_grants(ws, device_id, user.id, provider_ids)
                current_user, current_device, current_session, current_host = (
                    await _remote_identity(ws)
                )
                if (current_user.id != user.id or current_device != device_id
                        or current_session.project_id != project_id
                        or current_host != host_project_id):
                    raise HTTPException(status_code=403, detail="Project session revoked")
                if access_level == "edit" and current_session.project_access_level != "edit":
                    raise HTTPException(status_code=403, detail="Project edit access revoked")

            connection = await ws.app.state.control_connections.request_data(device_id)
            await connection.proxy_websocket(
                ws, user_id=user.id, username=user.username,
                display_name=user.display_name, provider_ids=provider_ids,
                provider_grant_expires_at=provider_grant_expires_at,
                project_id=host_project_id, access_level=access_level,
                authorization_check=authorize_stream,
            )
            return
        connection = await ws.app.state.control_connections.request_data(device_id)
        async def authorize_pc_stream():
            await _check_provider_grants(ws, device_id, user.id, provider_ids)
            current_user, current_device, current_session, _ = await _remote_identity(ws)
            if current_user.id != user.id or current_device != device_id or current_session.project_id:
                raise HTTPException(status_code=403, detail="Device session revoked")

        await connection.proxy_websocket(
            ws, authorization_check=authorize_pc_stream, user_id=user.id, username=user.username,
            display_name=user.display_name, provider_ids=provider_ids,
            provider_grant_expires_at=provider_grant_expires_at,
        )
    except HTTPException:
        await ws.close(code=4403)
    except (ConnectionError, asyncio.TimeoutError):
        await ws.close(code=1013)
