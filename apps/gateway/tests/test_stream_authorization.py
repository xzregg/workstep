import asyncio
import base64
from urllib.parse import urlsplit

import pytest

from gateway.contracts import GatewayCall
from gateway.services.control_connection import DataConnection
from workstep_gateway_protocol import FrameType, ProxyFrame


async def response_for(connection, authorize, *, interval=1, payload=b''):
    async def body():
        yield payload
    return await connection.proxy_http(
        GatewayCall(operation='POST' if payload else 'GET',
                    target=urlsplit('https://gateway.test/api/task/list'), payload=body),
        user_id='user', username='User', authorization_check=authorize,
        authorization_interval=interval,
    )


class Socket:
    def __init__(self):
        self.frames = []

    async def send_json(self, message):
        frame = ProxyFrame.model_validate(message)
        self.frames.append(frame)
        if frame.type == FrameType.http_request and frame.payload['phase'] == 'end':
            await self.connection.deliver(ProxyFrame(
                stream_id=frame.stream_id, type=FrameType.http_response,
                payload={'phase': 'start', 'status': 200, 'headers': []},
            ))


def connection():
    socket = Socket()
    socket.connection = DataConnection('device', socket)
    return socket.connection, socket


@pytest.mark.asyncio
@pytest.mark.parametrize('project', [False, True])
@pytest.mark.parametrize('workspace_path', ['', '/workspace/device/'])
async def test_remote_service_enables_reuse_for_device_and_project_assets(monkeypatch, project, workspace_path):
    from types import SimpleNamespace
    from gateway.services import remote_access_api as remote, stream_authorization
    monkeypatch.setattr(stream_authorization, 'monotonic', lambda: 0)
    checks = 0
    async def identity(call):
        return (SimpleNamespace(id='user', username='User', display_name='User'), 'device',
                SimpleNamespace(project_id='project' if project else None, project_access_level='read'),
                'host-project' if project else None)
    async def providers(*args):
        return [], []
    async def access(*args):
        nonlocal checks
        checks += 1
        return 'read'
    monkeypatch.setattr(remote, '_remote_identity', identity)
    monkeypatch.setattr(remote, 'compiled_provider_access', providers)
    monkeypatch.setattr(remote, '_active_access', access)
    monkeypatch.setattr(remote, '_active_project_access', access)
    class AssetSocket(Socket):
        async def send_json(self, message):
            await super().send_json(message)
            frame = ProxyFrame.model_validate(message)
            if frame.type == FrameType.http_request and frame.payload['phase'] == 'end':
                for _ in range(16):
                    await self.connection.deliver(ProxyFrame(stream_id=frame.stream_id,
                        type=FrameType.http_response, payload={'phase': 'body', 'data': 'eA=='}))
                await self.connection.deliver(ProxyFrame(stream_id=frame.stream_id,
                    type=FrameType.http_response, payload={'phase': 'end'}))
    socket = AssetSocket()
    conn = socket.connection = DataConnection('device', socket)
    async def connect(device):
        return conn
    async def body():
        yield b''
    call = GatewayCall(target=urlsplit('https://gateway.test/assets/app.js'),
        workspace_path=workspace_path, payload=body,
        control_connections=SimpleNamespace(request_data=connect))
    response = await remote.proxy_remote_request(call)
    assert b''.join([chunk async for chunk in response.chunks]) == b'x' * 16
    assert checks == 1
    assert not conn._streams


@pytest.mark.asyncio
@pytest.mark.parametrize('interval', [0, 1])
async def test_one_mib_upload_and_download_share_one_request_check(monkeypatch, interval):
    from gateway.services import stream_authorization
    monkeypatch.setattr(stream_authorization, 'monotonic', lambda: 0)
    checks = 0
    async def authorize():
        nonlocal checks
        checks += 1
    conn, socket = connection()
    content = b'x' * 16384
    response = await response_for(conn, authorize, interval=interval, payload=content * 64)
    stream_id = socket.frames[0].stream_id
    for _ in range(64):
        await conn.deliver(ProxyFrame(stream_id=stream_id, type=FrameType.http_response,
            payload={'phase': 'body', 'data': base64.b64encode(content).decode()}))
        assert await anext(response.chunks) == content
    await conn.deliver(ProxyFrame(stream_id=stream_id, type=FrameType.http_response,
                                 payload={'phase': 'end'}))
    assert [chunk async for chunk in response.chunks] == []
    if interval:
        assert checks == 1
    else:
        assert checks >= 190
    assert len([f for f in socket.frames if f.type == FrameType.http_request
                and f.payload['phase'] == 'body']) == 64
    assert not conn._streams


@pytest.mark.asyncio
async def test_recheck_rejects_queued_data_and_cleans_up(monkeypatch):
    from gateway.services import stream_authorization
    now = [0.0]
    monkeypatch.setattr(stream_authorization, 'monotonic', lambda: now[0])
    allowed = True
    async def authorize():
        if not allowed:
            raise PermissionError('revoked')
    conn, socket = connection()
    response = await response_for(conn, authorize)
    allowed = False
    now[0] = 1.0
    await conn.deliver(ProxyFrame(stream_id=socket.frames[0].stream_id,
        type=FrameType.http_response, payload={'phase': 'body', 'data': 'eA=='}))
    with pytest.raises(PermissionError):
        await anext(response.chunks)
    assert not conn._streams
    assert socket.frames[-1].type == FrameType.cancel


@pytest.mark.asyncio
async def test_idle_download_rechecks_without_waiting_for_data():
    allowed = True
    async def authorize():
        if not allowed:
            raise PermissionError('revoked')
    conn, socket = connection()
    response = await response_for(conn, authorize)
    allowed = False
    with pytest.raises(PermissionError):
        await asyncio.wait_for(anext(response.chunks), 2)
    assert not conn._streams
    assert socket.frames[-1].type == FrameType.cancel


@pytest.mark.asyncio
async def test_revocation_while_waiting_is_checked_before_delivering_frame(monkeypatch):
    from gateway.services import stream_authorization
    now = [0.0]
    monkeypatch.setattr(stream_authorization, 'monotonic', lambda: now[0])
    allowed = True
    async def authorize():
        if not allowed:
            raise PermissionError('revoked')
    conn, socket = connection()
    response = await response_for(conn, authorize)
    pending = asyncio.create_task(anext(response.chunks))
    await asyncio.sleep(0)
    allowed = False
    now[0] = 1.0
    await conn.deliver(ProxyFrame(stream_id=socket.frames[0].stream_id,
        type=FrameType.http_response, payload={'phase': 'body', 'data': 'eA=='}))
    with pytest.raises(PermissionError):
        await pending
    assert not conn._streams


@pytest.mark.asyncio
async def test_new_request_always_checks_even_on_same_connection():
    allowed = True
    async def authorize():
        if not allowed:
            raise PermissionError('revoked')
    conn, socket = connection()
    response = await response_for(conn, authorize)
    allowed = False
    count = len(socket.frames)
    with pytest.raises(PermissionError):
        await response_for(conn, authorize)
    assert len(socket.frames) == count
    await conn.deliver(ProxyFrame(stream_id=socket.frames[0].stream_id,
                                 type=FrameType.http_response, payload={'phase': 'end'}))
    assert [chunk async for chunk in response.chunks] == []


@pytest.mark.asyncio
async def test_concurrent_rechecks_coalesce_and_failure_stays_denied(monkeypatch):
    from gateway.services import stream_authorization
    now = [0.0]
    monkeypatch.setattr(stream_authorization, 'monotonic', lambda: now[0])
    checks = 0
    allowed = True
    async def authorize():
        nonlocal checks
        checks += 1
        await asyncio.sleep(0.01)
        if not allowed:
            raise PermissionError('revoked')
    check = stream_authorization.StreamAuthorizationCheck(authorize, interval=1)
    await asyncio.gather(*(check() for _ in range(8)))
    assert checks == 1
    now[0] = 1.0
    allowed = False
    results = await asyncio.gather(*(check() for _ in range(8)), return_exceptions=True)
    assert all(isinstance(result, PermissionError) for result in results)
    assert checks == 2
    allowed = True
    with pytest.raises(PermissionError):
        await check()


@pytest.mark.asyncio
async def test_slow_recheck_leaves_health_api_responsive():
    import httpx
    from fastapi import FastAPI
    app = FastAPI()
    @app.get('/health')
    async def health():
        return {'status': 'ok'}
    entered, release = asyncio.Event(), asyncio.Event()
    async def authorize():
        entered.set()
        await release.wait()
    conn, socket = connection()
    task = asyncio.create_task(response_for(conn, authorize))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            result = await asyncio.wait_for(client.get('/health'), 0.2)
            assert result.status_code == 200
        assert not task.done()
    finally:
        release.set()
    response = await task
    await conn.deliver(ProxyFrame(stream_id=socket.frames[0].stream_id,
                                 type=FrameType.http_response, payload={'phase': 'end'}))
    assert [chunk async for chunk in response.chunks] == []
