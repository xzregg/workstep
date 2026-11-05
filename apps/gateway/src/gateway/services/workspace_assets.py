"""Bounded, complete-before-send recovery for read-only workspace assets."""
import asyncio
import logging
from contextlib import aclosing
from dataclasses import replace

from gateway.contracts import SocketClosed
from gateway.services.errors import GatewayError

logger = logging.getLogger(__name__)

MAX_ASSET_BYTES = 8 * 1024 * 1024
ASSET_RECOVERY_SECONDS = 60


def is_workspace_asset(call):
    return bool(call.workspace_path and call.operation == 'GET'
                and call.target.path.startswith('/assets/'))


async def proxy_workspace_asset(call, connect, **identity):
    if not is_workspace_asset(call):
        raise ValueError('Only workspace asset reads can be retried')

    async def empty_body():
        yield b''

    # A browser GET has no upload to replay. Never reuse a consumed request iterator.
    call = replace(call, payload=empty_body, wire_headers=tuple(
        (key, value) for key, value in call.wire_headers
        if key.lower() not in (b'content-length', b'transfer-encoding')))
    async with asyncio.timeout(ASSET_RECOVERY_SECONDS):
        for attempt in range(3):
            try:
                connection = await connect()
                if connection._asset_waiters >= 64:
                    raise ConnectionError('Workspace asset queue full')
                connection._asset_waiters += 1
                try:
                    async with connection._asset_slots:
                        response = await connection.proxy_http(call, **identity)
                        content = bytearray()
                        async with aclosing(response.chunks):
                            async for chunk in response.chunks:
                                if len(content) + len(chunk) > MAX_ASSET_BYTES:
                                    raise GatewayError('upstream_failed', 'Workspace asset exceeds buffer limit')
                                content.extend(chunk)
                        if response.status >= 500:
                            raise ConnectionError('Device asset unavailable')
                        # The proxy validates upstream length before this point.
                        # No partial script or stylesheet can reach the browser.
                        async def complete(data=bytes(content)):
                            yield data
                        response.chunks = complete()
                        if response.status not in (204, 304):
                            response.headers['Content-Length'] = str(len(content))
                        return response
                finally:
                    connection._asset_waiters -= 1
            except (ConnectionError, SocketClosed, asyncio.TimeoutError) as exc:
                logger.warning('Workspace asset transfer interrupted (attempt=%s, error=%s)',
                               attempt + 1, type(exc).__name__)
                if attempt == 2:
                    raise
                await asyncio.sleep((0.25, 0.75)[attempt])
