"""One-time, host-bound entry into a managed PC's remote workspace."""

import hashlib
import asyncio
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlsplit

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .identity import COOKIE_NAME, IdentityService
from .models import Device, UsedDeviceAccessTicket, User, UserDevice

router = APIRouter(prefix="/api/remote")


def _device_host(request: Request) -> str:
    origin = request.app.state.settings.public_origin
    if origin is None:
        raise HTTPException(status_code=503, detail="Public Gateway origin is not configured")
    suffix = f".{urlsplit(origin).hostname}"
    host = request.headers.get("host", "").lower()
    if not host.startswith("d-") or not host.endswith(suffix) or ":" in host:
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


@router.post("/redeem")
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
        claims = request.app.state.gateway_signer.verify_device_access_ticket(
            ticket[0], gateway_id=request.app.state.settings.gateway_id, audience=host,
        )
    except (ValueError, KeyError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=403, detail="Invalid device access ticket") from exc
    device_id, user_id = claims["device_id"], claims["user_id"]
    if host != f"d-{device_id}.{urlsplit(request.app.state.settings.public_origin).hostname}":
        raise HTTPException(status_code=403, detail="Ticket device mismatch")
    await _active_access(request, user_id, device_id)
    auth_session, token = IdentityService._create_session(user_id)
    auth_session.device_id = device_id
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
    response.set_cookie(COOKIE_NAME, token, max_age=3600, secure=True,
                        httponly=True, samesite="lax", path="/")
    response.headers["Cache-Control"] = "no-store"
    return response


@router.get("/session")
async def remote_session(request: Request):
    user, device_id = await _remote_identity(request)
    return {"user_id": user.id, "device_id": device_id}


async def _remote_identity(request: Request) -> tuple[User, str]:
    host = _device_host(request)
    user, auth_session = await IdentityService(request.app.state.database).session_user(
        request.cookies.get(COOKIE_NAME), allow_device_session=True,
    )
    device_id = auth_session.device_id
    if not device_id or host != f"d-{device_id}.{urlsplit(request.app.state.settings.public_origin).hostname}":
        raise HTTPException(status_code=403, detail="Device session mismatch")
    await _active_access(request, user.id, device_id)
    return user, device_id


async def proxy_remote_request(request: Request):
    host = _device_host(request)
    origin = request.headers.get("origin")
    if request.method not in ("GET", "HEAD", "OPTIONS") and origin and origin != f"https://{host}":
        raise HTTPException(status_code=403, detail="Invalid remote origin")
    user, device_id = await _remote_identity(request)
    try:
        connection = await request.app.state.control_connections.request_data(device_id)
        return await connection.proxy_http(request, user_id=user.id, username=user.username)
    except (ConnectionError, asyncio.TimeoutError) as exc:
        raise HTTPException(status_code=502, detail="Device data connection unavailable") from exc
