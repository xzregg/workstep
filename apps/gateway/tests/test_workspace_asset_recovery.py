import asyncio
from urllib.parse import urlsplit

import pytest

from gateway.contracts import GatewayCall, StreamPayload
from gateway.services.control_connection import DataConnection
from gateway.services.workspace_assets import proxy_workspace_asset


def asset_call():
    return GatewayCall(operation='GET', target=urlsplit('https://gateway.test/assets/app.js'),
                       workspace_path='/workspace/device/')


@pytest.mark.asyncio
async def test_partial_download_restarts_on_new_connection_without_emitting_partial_bytes():
    first_chunk = asyncio.Event()
    resume = asyncio.Event()
    attempts = []
    async def broken():
        yield b'invalid partial script'
        first_chunk.set()
        await resume.wait()
        raise ConnectionError('Data connection closed')
    async def complete():
        yield b'complete '
        yield b'script'
    class Connection(DataConnection):
        async def proxy_http(self, call, **kwargs):
            attempts.append(kwargs)
            await kwargs['authorization_check']()
            return StreamPayload(broken() if len(attempts) == 1 else complete())
    connections = [Connection('device', None), Connection('device', None)]
    async def connect():
        return connections.pop(0)
    checks = 0
    async def authorize():
        nonlocal checks
        checks += 1
    task = asyncio.create_task(proxy_workspace_asset(asset_call(), connect,
                              authorization_check=authorize, user_id='user', username='alice'))
    await asyncio.wait_for(first_chunk.wait(), 1)
    assert not task.done(), 'Never return a successful response before the full script arrives'
    ticks = []
    asyncio.get_running_loop().call_soon(ticks.append, 'responsive')
    await asyncio.sleep(0)
    assert ticks, 'A stalled asset must not block the event loop'
    resume.set()
    response = await asyncio.wait_for(task, 2)
    assert b''.join([part async for part in response.chunks]) == b'complete script'
    assert len(attempts) == checks == 2
    assert response.headers['Content-Length'] == str(len(b'complete script'))


@pytest.mark.asyncio
async def test_asset_admission_queues_bursts_and_releases_cancelled_waiters():
    connection = DataConnection('device', None)
    active = 0
    peak = 0
    gate = asyncio.Event()
    entered = asyncio.Event()
    async def chunks():
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        if active == 8:
            entered.set()
        try:
            await gate.wait()
            yield b'ok'
        finally:
            active -= 1
    async def proxy(call, **kwargs):
        return StreamPayload(chunks())
    connection.proxy_http = proxy
    async def connect():
        return connection
    tasks = [asyncio.create_task(proxy_workspace_asset(asset_call(), connect)) for _ in range(40)]
    await asyncio.wait_for(entered.wait(), 1)
    tasks[-1].cancel()
    await asyncio.gather(tasks[-1], return_exceptions=True)
    assert peak == 8
    gate.set()
    responses = await asyncio.wait_for(asyncio.gather(*tasks[:-1]), 2)
    assert len(responses) == 39
    assert connection._asset_waiters == 0
    assert connection._asset_slots._value == 8


@pytest.mark.asyncio
async def test_retry_is_bounded_and_authorization_failure_is_not_retried():
    calls = 0
    connection = DataConnection('device', None)
    async def failing(call, **kwargs):
        nonlocal calls
        calls += 1
        raise ConnectionError('offline')
    connection.proxy_http = failing
    async def connect():
        return connection
    with pytest.raises(ConnectionError):
        await proxy_workspace_asset(asset_call(), connect)
    assert calls == 3
    async def forbidden(call, **kwargs):
        nonlocal calls
        calls += 1
        from gateway.services.errors import GatewayError
        raise GatewayError('forbidden', 'Access revoked')
    connection.proxy_http = forbidden
    from gateway.services.errors import GatewayError
    with pytest.raises(GatewayError):
        await proxy_workspace_asset(asset_call(), connect)
    assert calls == 4


@pytest.mark.asyncio
async def test_stalled_download_times_out_and_releases_slot(monkeypatch):
    from gateway.services import workspace_assets
    monkeypatch.setattr(workspace_assets, 'ASSET_RECOVERY_SECONDS', 0.05)
    connection = DataConnection('device', None)
    closed = asyncio.Event()
    async def chunks():
        try:
            yield b'partial'
            await asyncio.Event().wait()
        finally:
            closed.set()
    async def proxy(call, **kwargs):
        return StreamPayload(chunks())
    connection.proxy_http = proxy
    async def connect():
        return connection
    with pytest.raises(asyncio.TimeoutError):
        await proxy_workspace_asset(asset_call(), connect)
    assert closed.is_set()
    assert connection._asset_waiters == 0
    assert connection._asset_slots._value == 8


@pytest.mark.asyncio
async def test_buffer_limit_and_non_asset_writes_are_not_retried(monkeypatch):
    from gateway.services import workspace_assets
    from gateway.services.errors import GatewayError
    monkeypatch.setattr(workspace_assets, 'MAX_ASSET_BYTES', 3)
    attempts = 0
    connection = DataConnection('device', None)
    async def chunks():
        yield b'large'
    async def proxy(call, **kwargs):
        nonlocal attempts
        attempts += 1
        return StreamPayload(chunks())
    connection.proxy_http = proxy
    async def connect():
        return connection
    with pytest.raises(GatewayError):
        await proxy_workspace_asset(asset_call(), connect)
    assert attempts == 1
    call = asset_call()
    call.operation = 'POST'
    with pytest.raises(ValueError):
        await proxy_workspace_asset(call, connect)
    assert attempts == 1


@pytest.mark.asyncio
async def test_remote_service_recovers_assets_and_does_not_replay_api_requests(monkeypatch):
    from types import SimpleNamespace
    from gateway.services import remote_access_api as remote
    from gateway.services.errors import GatewayError
    async def identity(call, *, target_host_project_id=None):
        assert target_host_project_id is None
        return (SimpleNamespace(id='user', username='alice', display_name='Alice'),
                'device', SimpleNamespace(project_id=None), None)
    async def provider_access(*args):
        return [], []
    async def active_access(*args):
        pass
    monkeypatch.setattr(remote, '_remote_identity', identity)
    monkeypatch.setattr(remote, 'compiled_provider_access', provider_access)
    monkeypatch.setattr(remote, '_active_access', active_access)
    attempts = 0
    connection = DataConnection('device', None)
    async def chunks():
        yield b'valid script'
    async def proxy(call, **kwargs):
        nonlocal attempts
        attempts += 1
        await kwargs['authorization_check']()
        if attempts == 1 or call.operation == 'POST':
            raise ConnectionError('dropped')
        return StreamPayload(chunks())
    connection.proxy_http = proxy
    async def connect(device_id):
        return connection
    call = asset_call()
    call.control_connections = SimpleNamespace(request_data=connect)
    response = await remote.proxy_remote_request(call)
    assert b''.join([part async for part in response.chunks]) == b'valid script'
    assert attempts == 2
    call.operation = 'POST'
    call.target = urlsplit('https://gateway.test/api/task/execute')
    with pytest.raises(GatewayError):
        await remote.proxy_remote_request(call)
    assert attempts == 3, 'A failed API write must be dispatched only once'


@pytest.mark.asyncio
async def test_error_response_is_drained_before_retry_to_release_upstream_stream():
    connection = DataConnection('device', None)
    attempts = 0
    closed = 0
    async def chunks():
        nonlocal closed
        try:
            yield b'error or success'
        finally:
            closed += 1
    async def proxy(call, **kwargs):
        nonlocal attempts
        attempts += 1
        return StreamPayload(chunks(), status=502 if attempts == 1 else 200)
    connection.proxy_http = proxy
    async def connect():
        return connection
    response = await proxy_workspace_asset(asset_call(), connect)
    assert response.status == 200
    assert attempts == closed == 2
