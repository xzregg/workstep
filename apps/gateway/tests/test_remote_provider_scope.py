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
