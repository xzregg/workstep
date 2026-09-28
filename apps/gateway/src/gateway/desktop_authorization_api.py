"""Browser authorization and native Desktop PKCE exchange."""

import re
from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator

from .desktop_authorization import DesktopAuthorizationService
from .identity import COOKIE_NAME, IdentityService, public_user
from .identity_api import _check_csrf, _super_admin_read, _super_admin_request
from typing import Literal

router = APIRouter(prefix="/api")


class DesktopAuthorizeInput(BaseModel):
    state: str = Field(min_length=32, max_length=256)
    nonce: str = Field(min_length=32, max_length=256)
    code_challenge: str = Field(min_length=43, max_length=43)
    app_instance_id: str = Field(min_length=8, max_length=128)
    gateway_id: str = Field(min_length=1, max_length=128)

    @field_validator("code_challenge")
    @classmethod
    def valid_challenge(cls, value: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", value):
            raise ValueError("Invalid PKCE challenge")
        return value


class DesktopTokenInput(BaseModel):
    code: str = Field(min_length=32, max_length=256)
    state: str = Field(min_length=32, max_length=256)
    nonce: str = Field(min_length=32, max_length=256)
    code_verifier: str = Field(min_length=43, max_length=128)
    app_instance_id: str = Field(min_length=8, max_length=128)
    gateway_id: str = Field(min_length=1, max_length=128)
    device_public_key: str = Field(min_length=32, max_length=4096)
    device_name: str = Field(min_length=1, max_length=256)
    version: str = Field(min_length=1, max_length=64)
    rotation_signature: str | None = Field(default=None, max_length=256)


def _service(request: Request) -> DesktopAuthorizationService:
    return DesktopAuthorizationService(
        request.app.state.database, request.app.state.gateway_signer,
        request.app.state.settings.gateway_id,
    )


@router.get("/platform/gateway-key")
async def gateway_key(request: Request):
    signer = request.app.state.gateway_signer
    return {"gateway_id": request.app.state.settings.gateway_id,
            "public_key_pem": signer.public_key_pem, "fingerprint": signer.fingerprint}


@router.post("/desktop/authorize")
async def authorize_desktop(request: Request, body: DesktopAuthorizeInput):
    token = request.cookies.get(COOKIE_NAME)
    user, _ = await IdentityService(request.app.state.database).session_user(token)
    _check_csrf(request, token)
    if user.must_change_password:
        raise HTTPException(status_code=403, detail="Password change required")
    code = await _service(request).authorize(
        user.id, body.gateway_id, body.state, body.nonce,
        body.code_challenge, body.app_instance_id,
    )
    return {"callback_url": "workstep://auth/callback?" + urlencode({
        "code": code, "state": body.state,
    })}


@router.post("/desktop/token")
async def redeem_desktop_code(request: Request, body: DesktopTokenInput):
    user, device, signed = await _service(request).redeem(
        code=body.code, state=body.state, nonce=body.nonce,
        verifier=body.code_verifier, app_instance_id=body.app_instance_id,
        gateway_id=body.gateway_id, device_public_key=body.device_public_key,
        device_name=body.device_name, version=body.version,
        rotation_signature=body.rotation_signature,
    )
    return {"user": public_user(user),
            "device": {"id": device.id, "status": device.status},
            "device_authorization": signed}


@router.post("/admin/devices/{device_id}/approve", status_code=204)
async def approve_device(request: Request, device_id: str):
    identity, actor = await _super_admin_request(request)
    _, auth_session = await identity.session_user(request.cookies.get(COOKIE_NAME))
    await identity.require_step_up(auth_session)
    await _service(request).approve_device(device_id, actor.id)


@router.get("/admin/devices")
async def list_devices(request: Request, status: Literal["pending", "active", "disabled", "revoked"] | None = None,
                       q: str = Query(default='', max_length=128),
                       sort: Literal['created_at', 'name', 'status'] = 'created_at',
                       direction: Literal['asc', 'desc'] = 'desc',
                       page: int = Query(default=1, ge=1), page_size: int = Query(default=25, ge=1, le=100)):
    await _super_admin_read(request)
    devices, total = await _service(request).list_devices(
        status=status, q=q, sort=sort, direction=direction, page=page, page_size=page_size)
    return {"devices": [{"id": device.id, "name": device.name, "status": device.status,
                         "online": request.app.state.control_connections.is_online(device.id),
                         "version": device.version, "app_instance_id": device.app_instance_id}
                        for device in devices], "total": total, "page": page, "page_size": page_size}


async def _device_admin(request: Request):
    identity, actor = await _super_admin_request(request)
    _, auth_session = await identity.session_user(request.cookies.get(COOKIE_NAME))
    await identity.require_step_up(auth_session)
    return actor


@router.post("/admin/devices/{device_id}/disable", status_code=204)
async def disable_device(request: Request, device_id: str):
    actor = await _device_admin(request)
    await _service(request).change_device_status(device_id, actor.id, "disabled")
    await request.app.state.control_connections.disconnect(device_id)


@router.post("/admin/devices/{device_id}/revoke", status_code=204)
async def revoke_device(request: Request, device_id: str):
    actor = await _device_admin(request)
    await _service(request).change_device_status(device_id, actor.id, "revoked")
    await request.app.state.control_connections.disconnect(device_id)
