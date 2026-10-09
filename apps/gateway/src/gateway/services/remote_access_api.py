from gateway.services.errors import GatewayError
from gateway.contracts import GatewayCall, GatewaySocket, CredentialGrant, RedirectTarget
import hashlib

import asyncio

import time

from datetime import datetime, timezone

from urllib.parse import parse_qs


from sqlalchemy import select

from sqlalchemy.exc import IntegrityError

from workstep_gateway_protocol import project_http_route_allowed

from gateway.services.providers_api import compiled_provider_access

from gateway.services.capabilities import compiled_device_policy

from gateway.services.identity_errors import IdentityError
from gateway.services.identity import COOKIE_NAME, IdentityService

from gateway.models import Device, PlatformProject, UsedDeviceAccessTicket, User, UserDevice

from gateway.services.project_access_api import effective_project_access, project_grant_rows

from gateway.services.platform_shares import can_create_platform_share


"""One-time, host-bound entry into a managed PC's remote workspace."""


def _device_host(call: GatewayCall) -> str:
    origin = call.settings.public_origin
    if origin is None:
        raise GatewayError('unavailable', 'Public Gateway origin is not configured')
    if call.workspace_device_id:
        return call.settings.device_authority(call.workspace_device_id)
    host = call.proofs.get('host', '').lower()
    if not call.settings.is_device_authority(host):
        raise GatewayError('forbidden', 'Device host required')
    return host


async def _active_access(call: GatewayCall, user_id: str, device_id: str) -> None:
    async with call.database.session() as session:
        user = await session.get(User, user_id)
        device = await session.get(Device, device_id)
        from gateway.services.device_grants import has_device_access
        assignment = await has_device_access(session,user_id,device_id)
    if (not user or user.status != "active"
            or not device or device.status != "active" or not assignment):
        raise GatewayError('forbidden', 'Device access denied')
    if not call.control_connections.is_online(device_id):
        raise GatewayError('conflict', 'Device is offline')


async def _active_project_access(call: GatewayCall, user_id: str, device_id: str,
                                 project_id: str, host_project_id: str) -> str:
    async with call.database.session() as session:
        user = await session.get(User, user_id)
        device = await session.get(Device, device_id)
        project = await session.get(PlatformProject, project_id)
        level = await effective_project_access(session, user_id, project_id)
    if (not user or user.status != "active"
            or not device or device.status != "active" or not project
            or project.device_id != device_id or project.host_project_id != host_project_id
            or project.status != "active" or project.access_mode != "remote_published"
            or level is None):
        raise GatewayError('forbidden', 'Project access denied')
    if not call.control_connections.is_online(device_id):
        raise GatewayError('conflict', 'Device is offline')
    return level


async def _project_task_create_allowed(call: GatewayCall, device_id: str,
                                       user_id: str, host_project_id: str) -> bool:
    _, broad, _, allowed, denied = await compiled_device_policy(call.database, device_id, user_id)
    return (broad or host_project_id in allowed) and host_project_id not in denied


async def _remote_identity(call: GatewayCall):
    host = _device_host(call)
    user, auth_session = await IdentityService(call.database).session_user(call.tokens.get(COOKIE_NAME), allow_device_session=True)
    device_id = auth_session.device_id
    if not device_id or host != call.settings.device_authority(device_id):
        raise GatewayError('forbidden', 'Device session mismatch')
    if auth_session.project_id:
        async with call.database.session() as session:
            project = await session.get(PlatformProject, auth_session.project_id)
        if project is None:
            raise GatewayError('forbidden', 'Project unavailable')
        current_level = await _active_project_access(call, user.id, device_id, project.id, project.host_project_id)
        if current_level == "read":
            auth_session.project_access_level = "read"
        host_project_id = project.host_project_id
    else:
        await _active_access(call, user.id, device_id)
        host_project_id = None
    return user, device_id, auth_session, host_project_id


async def _check_provider_grants(call, device_id: str, user_id: str, provider_ids: list[str]):
    current, _ = await compiled_provider_access(call.database, device_id, user_id)
    if set(provider_ids) - set(current):
        raise GatewayError('forbidden', 'Provider access revoked')


async def proxy_remote_request(call: GatewayCall):
    user, device_id, auth_session, host_project_id = await _remote_identity(call)
    provider_ids, _ = await compiled_provider_access(call.database, device_id, user.id)
    provider_grant_expires_at = int(time.time()) + 300
    owner_routes = {'/api/project/init', '/api/project/register', '/api/fs/mkdir'}
    native_directory = call.target.path in {'/api/fs/browse', '/api/fs/search'} and not call.query_values.get('project_id')
    device_owner = False
    if not auth_session.project_id and (call.target.path in owner_routes or native_directory or call.target.path == '/api/managed/mode'):
        async with call.database.session() as session:
            device = await session.get(Device, device_id)
            device_owner = device is not None and device.owner_user_id == user.id
    if (call.target.path in owner_routes or native_directory) and not device_owner:
        raise GatewayError('forbidden', 'Device ownership required')
    task_create = False
    if auth_session.project_id:
        if call.operation == 'POST' and call.target.path in ('/api/task/create', '/api/task/copy'):
            task_create = await _project_task_create_allowed(call, device_id, user.id, host_project_id)
        if not project_http_route_allowed(call.operation, call.target.path, list(call.query_values.multi_items()), host_project_id, access_level=auth_session.project_access_level, task_create=task_create):
            raise GatewayError('forbidden', 'Project proxy scope unavailable')
    try:
        connection = await call.control_connections.request_data(device_id)
        if auth_session.project_id:
            async def authorize_stream():
                await _check_provider_grants(call, device_id, user.id, provider_ids)
                current_level = await _active_project_access(call, user.id, device_id, auth_session.project_id, host_project_id)
                if auth_session.project_access_level == "edit" and current_level != "edit":
                    raise GatewayError('forbidden', 'Project edit access revoked')
                if task_create:
                    if not await _project_task_create_allowed(call, device_id, user.id, host_project_id):
                        raise GatewayError('forbidden', 'Task creation capability revoked')

            return await connection.proxy_http(call, user_id=user.id, username=user.username, display_name=user.display_name, provider_ids=provider_ids, provider_grant_expires_at=provider_grant_expires_at, project_id=host_project_id, access_level=auth_session.project_access_level, task_create=task_create, authorization_check=authorize_stream)
        async def authorize_pc_stream():
            await _check_provider_grants(call, device_id, user.id, provider_ids)
            await _active_access(call, user.id, device_id)

        return await connection.proxy_http(call, device_owner=device_owner, authorization_check=authorize_pc_stream, user_id=user.id, username=user.username, display_name=user.display_name, provider_ids=provider_ids, provider_grant_expires_at=provider_grant_expires_at)
    except (ConnectionError, asyncio.TimeoutError) as exc:
        raise GatewayError('upstream_failed', 'Device data connection unavailable') from exc


async def redeem_device_ticket(call: GatewayCall):
    host = _device_host(call)
    if call.proofs.get('content-type', '').split(';')[0] != 'application/x-www-form-urlencoded':
        raise GatewayError('unsupported', 'Form data required')
    body = await call.read_payload()
    if len(body) > 16384:
        raise GatewayError('too_large', 'Ticket too large')
    try:
        fields = parse_qs(body.decode("ascii"), strict_parsing=True)
        ticket = fields["ticket"]
        if len(ticket) != 1:
            raise ValueError("Ticket count")
        claims = call.gateway_signer.verify_access_ticket(ticket[0], gateway_id=call.settings.gateway_id, audience=host)
    except (ValueError, KeyError, UnicodeDecodeError) as exc:
        raise GatewayError('forbidden', 'Invalid device access ticket') from exc
    next_path = fields.get('next', [''])[0]
    if next_path and not (next_path.startswith('tasks?') or next_path.startswith('chat?')):
        raise GatewayError('invalid', 'Invalid workspace destination')
    device_id, user_id = claims["device_id"], claims["user_id"]
    if host != call.settings.device_authority(device_id):
        raise GatewayError('forbidden', 'Ticket device mismatch')
    if claims["kind"] == "project.access":
        current_level = await _active_project_access(call, user_id, device_id, claims['project_id'], claims['host_project_id'])
    else:
        await _active_access(call, user_id, device_id)
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
        async with call.database.session() as session:
            async with session.begin():
                session.add(UsedDeviceAccessTicket(
                    jti_hash=hashlib.sha256(claims["jti"].encode()).hexdigest(),
                    user_id=user_id, device_id=device_id,
                    expires_at=datetime.fromtimestamp(claims["exp"], timezone.utc),
                ))
                session.add(auth_session)
    except IntegrityError as exc:
        raise GatewayError('conflict', 'Ticket already used') from exc
    response = RedirectTarget((call.workspace_path or '/') + next_path)
    response.grants.append(CredentialGrant('workstep_remote_session' if call.workspace_path else COOKIE_NAME, token, lifetime=3600, path=call.workspace_path or '/'))
    if call.workspace_device_id:
        response.grants.append(CredentialGrant('workstep_remote_ws_session', token, lifetime=3600,
                                               path='/ws/workspace/' + call.workspace_device_id))
    response.headers["Cache-Control"] = "no-store"
    return response


async def remote_session(call: GatewayCall):
    user, device_id, auth_session, host_project_id = await _remote_identity(call)
    task_create = auth_session.project_access_level == 'edit' and host_project_id is not None and await _project_task_create_allowed(call, device_id, user.id, host_project_id)
    async with call.database.session() as session:
        device = await session.get(Device, device_id)
        project = await session.get(PlatformProject, auth_session.project_id) if auth_session.project_id else None
        share_create = (await can_create_platform_share(session, user.id, project)
                        if project is not None else False)
    if device is None:
        raise GatewayError('forbidden', 'Device access denied')
    return {"user_id": user.id, "username": user.display_name,
            "device_id": device_id, "device_name": device.name,
            "project_id": auth_session.project_id,
            "host_project_id": host_project_id,
            "access_level": auth_session.project_access_level,
            "task_create": task_create,
            "share_create": share_create,
            "can_manage_project_access": await IdentityService(call.database).is_super_admin(user.id),
            "online": True,
            "gateway_url": call.settings.public_origin + "/devices"}


async def remote_project_grants(call: GatewayCall):
    user, device_id, auth_session, _ = await _remote_identity(call)
    if auth_session.project_id is None:
        raise GatewayError('forbidden', 'Project session required')
    async with call.database.session() as session:
        rows = await project_grant_rows(session, auth_session.project_id)
        device = await session.get(Device, device_id)
        can_invite = bool(device and device.owner_user_id == user.id)
    return {"can_invite": can_invite, "grants": [{key: row[key] for key in (
        "subject_type", "subject_id", "subject_name", "access_level",
    )} for row in rows]}


async def proxy_remote_websocket(ws: GatewaySocket, path: str):
    try:
        user, device_id, auth_session, host_project_id = await _remote_identity(ws)
        provider_ids, _ = await compiled_provider_access(ws.database, device_id, user.id)
        provider_grant_expires_at = int(time.time()) + 300
        if auth_session.project_id:
            if ws.target.path != '/ws':
                raise GatewayError('forbidden', 'Project proxy scope unavailable')
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
                    raise GatewayError('forbidden', 'Project session revoked')
                if access_level == "edit" and current_session.project_access_level != "edit":
                    raise GatewayError('forbidden', 'Project edit access revoked')

            connection = await ws.control_connections.request_data(device_id)
            await connection.proxy_websocket(
                ws, user_id=user.id, username=user.username,
                display_name=user.display_name, provider_ids=provider_ids,
                provider_grant_expires_at=provider_grant_expires_at,
                project_id=host_project_id, access_level=access_level,
                authorization_check=authorize_stream,
            )
            return
        connection = await ws.control_connections.request_data(device_id)
        async def authorize_pc_stream():
            await _check_provider_grants(ws, device_id, user.id, provider_ids)
            current_user, current_device, current_session, _ = await _remote_identity(ws)
            if current_user.id != user.id or current_device != device_id or current_session.project_id:
                raise GatewayError('forbidden', 'Device session revoked')

        await connection.proxy_websocket(
            ws, authorization_check=authorize_pc_stream, user_id=user.id, username=user.username,
            display_name=user.display_name, provider_ids=provider_ids,
            provider_grant_expires_at=provider_grant_expires_at,
        )
    except (GatewayError, IdentityError):
        await ws.close(code=4403)
    except (ConnectionError, asyncio.TimeoutError):
        await ws.close(code=1013)


async def remote_devices(call: GatewayCall):
    user, _, auth, _ = await _remote_identity(call)
    if auth.project_id:
        raise GatewayError('forbidden', 'Whole-device session required')
    from gateway.services.user_devices_api import assigned_devices_for_user
    return await assigned_devices_for_user(call, user.id)


async def remote_device_access(call: GatewayCall, device_id: str):
    user, _, auth, _ = await _remote_identity(call)
    if auth.project_id:
        raise GatewayError('forbidden', 'Whole-device session required')
    from gateway.services.user_devices_api import device_access_for_user
    return await device_access_for_user(call, device_id, user.id)
