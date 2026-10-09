from types import SimpleNamespace

import pytest
from gateway.services.errors import GatewayError
from gateway.contracts import GatewayCall

from gateway.services import remote_access_api as remote


@pytest.mark.asyncio
async def test_stream_checks_current_user_supplier_grants(monkeypatch):
    current = ['supplier', 'newly-granted']
    async def compile_access(database, device_id, user_id):
        assert (database, device_id, user_id) == ('db', 'pc', 'remote-user')
        return current, []
    monkeypatch.setattr(remote, 'compiled_provider_access', compile_access)
    request = GatewayCall(database='db')
    await remote._check_provider_grants(request, 'pc', 'remote-user', ['supplier'])
    current.remove('supplier')
    with pytest.raises(GatewayError) as rejected:
        await remote._check_provider_grants(request, 'pc', 'remote-user', ['supplier'])
    assert rejected.value.reason == "forbidden"

@pytest.mark.asyncio
async def test_pc_http_stream_rechecks_user_and_provider_grants(monkeypatch):
    current = ['supplier']
    async def identity(request):
        return SimpleNamespace(id='remote-user', username='remote', display_name='Remote'), 'pc', SimpleNamespace(project_id=None), None
    async def compile_access(*args): return current.copy(), []
    async def active_access(*args): return None
    request = GatewayCall(database='db')
    class Connection:
        async def proxy_http(self, request, **kwargs):
            assert 'authorization_check' in kwargs
            await kwargs['authorization_check']()
            current.clear()
            with pytest.raises(GatewayError): await kwargs['authorization_check']()
            return 'response'
    async def request_data(device): return Connection()
    request.control_connections = SimpleNamespace(request_data=request_data)
    monkeypatch.setattr(remote, '_remote_identity', identity)
    monkeypatch.setattr(remote, 'compiled_provider_access', compile_access)
    monkeypatch.setattr(remote, '_active_access', active_access)
    assert await remote.proxy_remote_request(request) == 'response'


@pytest.mark.asyncio
@pytest.mark.parametrize('owner,path,expected', [
    (True, '/api/project/init', True), (False, '/api/project/init', False),
    (True, '/api/managed/mode', True), (False, '/api/managed/mode', False),
])
async def test_remote_owner_capability_comes_from_persisted_device(monkeypatch, owner, path, expected):
    from contextlib import asynccontextmanager
    from urllib.parse import urlsplit
    class Session:
        async def get(self, model, device_id):
            return SimpleNamespace(owner_user_id='a' if owner else 'b')
    @asynccontextmanager
    async def session(): yield Session()
    async def identity(call):
        return SimpleNamespace(id='a', username='alice', display_name='Alice'), 'pc', SimpleNamespace(project_id=None), None
    async def compile_access(*args): return [], []
    class Connection:
        async def proxy_http(self, call, **kwargs):
            assert kwargs['device_owner'] is expected
            return 'ok'
    async def request_data(device): return Connection()
    call = GatewayCall(database=SimpleNamespace(session=session), target=urlsplit("http://localhost" + path),
                       control_connections=SimpleNamespace(request_data=request_data))
    monkeypatch.setattr(remote, '_remote_identity', identity)
    monkeypatch.setattr(remote, 'compiled_provider_access', compile_access)
    if not owner and path == '/api/project/init':
        with pytest.raises(GatewayError): await remote.proxy_remote_request(call)
    else: assert await remote.proxy_remote_request(call) == 'ok'
