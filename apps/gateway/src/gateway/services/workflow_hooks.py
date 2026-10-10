"""Route a fixed webhook request to an authenticated device, without hook data."""
import asyncio
import re
from dataclasses import replace

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from cryptography.hazmat.primitives import serialization
from cryptography.exceptions import InvalidSignature
import base64
from workstep_gateway_protocol.hooks import HOOK_PATH, MAX_HOOK_BODY

from gateway.models import Device
from gateway.services.errors import GatewayError



async def bind_hook_identity(ws, device_id, hello, nonce):
    local_id = hello.get('hook_device_id')
    if local_id is None:
        return  # Old clients can still connect, but have no public hook route.
    if not isinstance(local_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', local_id):
        raise ValueError('Invalid hook device identity')
    try:
        key = serialization.load_pem_public_key(hello['control_public_key_pem'].encode())
        key.verify(base64.urlsafe_b64decode(hello['hook_device_proof'] + '==='),
                   f"workstep-hook-device-v1:{nonce}:{hello['authorization']}:{local_id}".encode())
    except (KeyError, ValueError, TypeError, InvalidSignature) as exc:
        raise ValueError('Invalid hook device proof') from exc
    try:
        async with ws.database.session() as session:
            async with session.begin():
                device = await session.get(Device, device_id)
                if device.hook_device_id not in (None, local_id):
                    raise ValueError('Hook device identity is immutable')
                device.hook_device_id = local_id
    except IntegrityError as exc:
        raise ValueError('Hook device identity belongs to another device') from exc


async def proxy_hook(call, device_id, hook_id):
    if call.operation != 'POST' or not HOOK_PATH.fullmatch(call.target.path):
        raise GatewayError('forbidden', 'Hook route denied')
    pairs = list(call.query_values.multi_items())
    if any(k not in {'token', 'step_key', 'title', 'creator'} for k, _ in pairs) or len(dict(pairs)) != len(pairs):
        raise GatewayError('invalid', 'Invalid hook parameters')
    async with call.database.session() as session:
        device = await session.scalar(select(Device).where(Device.hook_device_id == device_id))
    if device is None:
        raise GatewayError('not_found', 'Device not registered for hooks')
    if device.status != 'active':
        raise GatewayError('forbidden', 'Device unavailable')
    if not call.control_connections.is_online(device.id):
        raise GatewayError('unavailable', 'Device is offline')
    chunks, size = [], 0
    async for chunk in call.payload():
        size += len(chunk)
        if size > MAX_HOOK_BODY:
            raise GatewayError('too_large', 'Hook body exceeds 1 MiB')
        chunks.append(chunk)
    async def payload():
        for chunk in chunks:
            yield chunk
    call = replace(call, payload=payload)
    async def authorize():
        async with call.database.session() as session:
            current = await session.get(Device, device.id)
            if current is None or current.status != 'active' or current.hook_device_id != device_id:
                raise GatewayError('forbidden', 'Device unavailable')
    try:
        connection = await call.control_connections.request_data(device.id)
        return await connection.proxy_http(call, hook_request=True, authorization_check=authorize)
    except (ConnectionError, asyncio.TimeoutError) as exc:
        raise GatewayError('unavailable', 'Device connection unavailable') from exc
