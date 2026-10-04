from gateway.services.errors import GatewayError
from gateway.contracts import GatewayCall
import re

from typing import Literal

from urllib.parse import urlencode, urlsplit


from pydantic import BaseModel, Field, field_validator

from packaging.version import InvalidVersion, Version

from sqlalchemy import select, tuple_

from gateway.services.desktop_authorization import DesktopAuthorizationService

from gateway.services.identity import COOKIE_NAME, IdentityService, public_user

from gateway.services.identity_api import _check_csrf

from gateway.models import ClientRelease

from gateway.services.management_scope import device_manager


"""Browser authorization and native Desktop PKCE exchange."""


class DesktopAuthorizeInput(BaseModel):
    state: str = Field(min_length=32, max_length=256)
    nonce: str = Field(min_length=32, max_length=256)
    code_challenge: str = Field(min_length=43, max_length=43)
    app_instance_id: str = Field(min_length=8, max_length=128)
    gateway_id: str = Field(min_length=1, max_length=128)
    redirect_uri: str | None = Field(default=None, max_length=2048)

    @field_validator("redirect_uri")
    @classmethod
    def local_callback(cls, value: str | None) -> str | None:
        if value is None: return None
        parsed = urlsplit(value)
        if (parsed.scheme != "http" or parsed.hostname not in ("localhost", "127.0.0.1", "::1")
                or not parsed.port or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path != "/api/gateway-platform/callback"):
            raise ValueError("Invalid daemon callback")
        return value

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
    os: Literal["macos", "windows", "linux"] | None = None
    arch: Literal["arm64", "x64"] | None = None
    rotation_signature: str | None = Field(default=None, max_length=256)


def _service(call: GatewayCall) -> DesktopAuthorizationService:
    return DesktopAuthorizationService(call.database, call.gateway_signer, call.settings.gateway_id)


async def gateway_key(call: GatewayCall):
    signer = call.gateway_signer
    return {"gateway_id": call.settings.gateway_id,
            "public_key_pem": signer.public_key_pem, "fingerprint": signer.fingerprint}


async def authorize_desktop(call: GatewayCall, body: DesktopAuthorizeInput):
    token = call.tokens.get(COOKIE_NAME)
    user, _ = await IdentityService(call.database).session_user(token)
    _check_csrf(call, token)
    if user.must_change_password:
        raise GatewayError('forbidden', 'Password change required')
    code = await _service(call).authorize(user.id, body.gateway_id, body.state, body.nonce, body.code_challenge, body.app_instance_id)
    return {"callback_url": (body.redirect_uri or "workstep://auth/callback") + "?" + urlencode({
        "code": code, "state": body.state,
    })}


async def redeem_desktop_code(call: GatewayCall, body: DesktopTokenInput):
    user, device, signed = await _service(call).redeem(code=body.code, state=body.state, nonce=body.nonce, verifier=body.code_verifier, app_instance_id=body.app_instance_id, gateway_id=body.gateway_id, device_public_key=body.device_public_key, device_name=body.device_name, version=body.version, os=body.os if body.arch else None, arch=body.arch if body.os else None, rotation_signature=body.rotation_signature)
    return {"user": public_user(user),
            "device": {"id": device.id, "status": device.status},
            "device_authorization": signed}


async def approve_device(call: GatewayCall, device_id: str):
    _, actor, _ = await device_manager(call, device_ids=[device_id], mutation=True)
    await _service(call).approve_device(device_id, actor.id)


async def list_devices(call: GatewayCall, status: Literal["pending", "active", "disabled", "revoked"] | None = None,
                       q: str = '',
                       sort: Literal['created_at', 'name', 'status'] = 'created_at',
                       direction: Literal['asc', 'desc'] = 'desc',
                       page: int = 1, page_size: int = 25):
    _, _, allowed = await device_manager(call)
    devices, total = await _service(call).list_devices(status=status, q=q, sort=sort, direction=direction, page=page, page_size=page_size, allowed_ids=allowed)
    platforms = {(device.os, device.arch) for device in devices if device.os and device.arch}
    latest: dict[tuple[str, str], tuple[Version, str]] = {}
    if platforms:
        async with call.database.session() as session:
            releases = (await session.scalars(select(ClientRelease).where(ClientRelease.gateway_id == call.settings.gateway_id, ClientRelease.status == 'published', tuple_(ClientRelease.os, ClientRelease.arch).in_(platforms)))).all()
        for release in releases:
            platform = (release.os, release.arch)
            if platform not in platforms:
                continue
            try:
                parsed = Version(release.version)
            except InvalidVersion:
                continue
            if platform not in latest or parsed > latest[platform][0]:
                latest[platform] = (parsed, release.version)

    def release_status(device):
        current = latest.get((device.os, device.arch))
        if current is None:
            return None, None
        try:
            return current[1], Version(device.version) < current[0]
        except (InvalidVersion, TypeError):
            return current[1], None

    result = []
    for device in devices:
        latest_version, update_available = release_status(device)
        result.append({'id': device.id, 'name': device.name, 'status': device.status, 'department_id': device.department_id, 'online': call.control_connections.is_online(device.id), 'daemon_health': call.control_connections.daemon_health(device.id), 'version': device.version, 'os': device.os, 'arch': device.arch, 'latest_version': latest_version, 'update_available': update_available, 'app_instance_id': device.app_instance_id})
    return {"devices": result, "total": total, "page": page, "page_size": page_size}


async def disable_device(call: GatewayCall, device_id: str):
    _, actor, _ = await device_manager(call, device_ids=[device_id], mutation=True)
    await _service(call).change_device_status(device_id, actor.id, 'disabled')
    await call.control_connections.disconnect(device_id)


async def revoke_device(call: GatewayCall, device_id: str):
    _, actor, _ = await device_manager(call, device_ids=[device_id], mutation=True)
    await _service(call).change_device_status(device_id, actor.id, 'revoked')
    await call.control_connections.disconnect(device_id)
