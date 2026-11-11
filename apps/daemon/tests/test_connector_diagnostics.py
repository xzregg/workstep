import asyncio
import json
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI


@pytest.mark.asyncio
async def test_draft_test_discovers_and_calls_real_mcp_without_saving(tmp_path, monkeypatch):
    from api import connectors
    from services.connectors.store import ConnectorStore
    store = ConnectorStore(tmp_path / 'connectors')
    monkeypatch.setattr(connectors, 'connector_store', store)
    app = FastAPI()
    app.include_router(connectors.router)
    draft = dict(name='Demo', kind='mcp', transport='stdio', command=sys.executable,
                 args=[str(Path(__file__).resolve().parents[3] / 'scripts/mcp_demo_server.py')])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        result = (await client.post('/api/connectors/test', json={'definition': draft})).json()
        assert result['status'] == 'connected'
        assert {tool['name'] for tool in result['tools']} == {'echo', 'add', 'get_demo_info'}
        assert next(t for t in result['tools'] if t['name'] == 'add')['input_schema']['properties']
        result = (await client.post('/api/connectors/test', json={
            'definition': draft, 'tool_name': 'add', 'arguments': {'a': 2, 'b': 3},
        })).json()
        assert result['ok']
        assert '5' in json.dumps(result['result'])
        unknown = (await client.post('/api/connectors/test', json={
            'definition': draft, 'tool_name': 'not-a-tool', 'arguments': {},
        })).json()
        assert not unknown['ok']
        assert store.list() == []
        assert not (store.directory / 'definitions.enc').exists()


@pytest.mark.asyncio
@pytest.mark.parametrize('code,status', [(401, 'auth_required'), (403, 'forbidden')])
async def test_auth_failures_are_structured_and_redacted(monkeypatch, code, status):
    from services.connectors import transport
    @asynccontextmanager
    async def fail(_):
        request = httpx.Request('GET', 'https://example.com/private?token=do-not-print')
        raise ExceptionGroup('transport', [httpx.HTTPStatusError('secret-token', request=request,
            response=httpx.Response(code, request=request, headers={'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/auth"'}))])
        yield
    monkeypatch.setattr(transport, 'connect', fail)
    result = await transport.diagnose({'kind': 'mcp'})
    assert result['status'] == status
    assert 'secret-token' not in json.dumps(result)
    assert 'do-not-print' not in json.dumps(result)
    assert result['auth_scheme'] == 'bearer'


@pytest.mark.asyncio
async def test_timeout_and_successful_tool_output_redact_secrets(monkeypatch):
    from types import SimpleNamespace
    from services.connectors import transport
    class Client:
        async def list_tools(self, **kwargs):
            return SimpleNamespace(tools=[SimpleNamespace(name='echo', description='', inputSchema={})], nextCursor=None)
        async def call_tool(self, name, arguments):
            return SimpleNamespace(isError=False, model_dump=lambda **_: {'content': ['Bearer private-token', 'private-token']})
    @asynccontextmanager
    async def success(_):
        yield Client()
    monkeypatch.setattr(transport, 'connect', success)
    result = await transport.diagnose({'kind': 'mcp', 'headers': {'Authorization': 'Bearer private-token'}}, tool_name='echo')
    assert result['ok']
    assert 'private-token' not in json.dumps(result)
    @asynccontextmanager
    async def timeout(_):
        raise TimeoutError('private-token')
        yield
    monkeypatch.setattr(transport, 'connect', timeout)
    result = await transport.diagnose({'kind': 'mcp'})
    assert result['status'] == 'timeout'
    assert 'private-token' not in json.dumps(result)


def test_preview_preserves_existing_secrets_without_mutation(tmp_path):
    from services.connectors.store import ConnectorStore
    store = ConnectorStore(tmp_path / 'connectors')
    saved = store.save(dict(name='Demo', kind='mcp', transport='http', url='https://example.com/mcp', headers={'Authorization': 'Bearer saved-secret'}))
    before = (store.directory / 'definitions.enc').read_bytes()
    assert store.preview(saved)['headers']['Authorization'] == 'Bearer saved-secret'
    assert (store.directory / 'definitions.enc').read_bytes() == before
    with pytest.raises(ValueError):
        store.preview({**saved, 'revision': 0})


@pytest.mark.asyncio
async def test_diagnostic_api_keeps_host_boundary_and_slow_disk_off_loop(tmp_path, monkeypatch):
    import time
    from api import connectors
    from services.connectors.store import ConnectorStore
    from services.remote_access import ActorSnapshot, actor_context
    store = ConnectorStore(tmp_path / 'connectors')
    monkeypatch.setattr(connectors, 'connector_store', store)
    original = store.preview
    def slow(value):
        time.sleep(.15)
        return original(value)
    monkeypatch.setattr(store, 'preview', slow)
    async def diagnose(item, **kwargs):
        await asyncio.sleep(.15)
        return {'ok': True, 'status': 'connected', 'tool_count': 0, 'tools': []}
    monkeypatch.setattr('services.connectors.transport.diagnose', diagnose)
    app = FastAPI()
    app.include_router(connectors.router)
    @app.get('/health')
    async def health():
        return {'ok': True}
    body = {'definition': {'name': 'Demo', 'kind': 'cli', 'command': 'gh'}}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        pending = asyncio.create_task(client.post('/api/connectors/test', json=body))
        await asyncio.sleep(.03)
        assert not pending.done()
        assert (await asyncio.wait_for(client.get('/health'), .08)).status_code == 200
        await asyncio.sleep(.16)
        assert not pending.done(), 'network phase is still pending'
        assert (await asyncio.wait_for(client.get('/health'), .08)).status_code == 200
        assert (await pending).status_code == 200
        actor = ActorSnapshot('remote', 'Remote', 'device', 'Device', 'remote', project_id='p', access_level='edit')
        with actor_context(actor):
            assert (await client.post('/api/connectors/test', json=body)).status_code == 403
