"""Connector scope, credential custody and the opt-in engine seam."""
import asyncio
import json
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI


def make_store(tmp_path):
    from services.connectors.store import ConnectorStore
    return ConnectorStore(tmp_path / 'connectors')


def definition(**overrides):
    return dict(name='Design', kind='mcp', transport='http',
                url='https://example.com/mcp', project_ids=[], **overrides)


def test_credentials_are_encrypted_and_never_returned(tmp_path):
    store = make_store(tmp_path)
    saved = store.save({**definition(), 'headers': {'Authorization': 'Bearer private-value'}})
    assert 'private-value' not in json.dumps(saved)
    assert saved['has_credentials'] is True
    assert 'private-value' not in ''.join(p.read_text() for p in store.directory.iterdir())
    assert store.resolve(saved['id'])['headers']['Authorization'] == 'Bearer private-value'
    store.save({**saved, 'name': 'Updated'})
    assert store.resolve(saved['id'])['headers']['Authorization'] == 'Bearer private-value'


def test_project_whitelist_and_session_selection_are_independent(tmp_path):
    store = make_store(tmp_path)
    global_item = store.save(definition())
    limited = store.save({**definition(), 'name': 'Limited', 'project_ids': ['p1']})
    store.select('p1', 's1', [global_item['id'], limited['id']])
    assert len(store.selected('p1', 's1')) == 2
    assert store.selected('p1', 's2') == []
    with pytest.raises(PermissionError):
        store.select('p2', 's1', [limited['id']])
    store.save({**limited, 'project_ids': ['p2']})
    assert [i['id'] for i in store.selected('p1', 's1')] == [global_item['id']]
    store.select('p1', 's1', [])
    assert store.resolve(global_item['id'])  # switching off does not disconnect


def test_deleted_project_whitelist_does_not_become_global(tmp_path):
    store = make_store(tmp_path)
    item = store.save({**definition(), 'project_ids': ['deleted-project']})
    assert not store.allowed(item, 'new-project')


def test_scan_redacts_secrets_and_requires_explicit_import(tmp_path, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda _: None)
    from services.connectors.discovery import scan_local
    home = tmp_path / 'home'
    (home / '.codex').mkdir(parents=True)
    source = home / '.codex/config.toml'
    source.write_text('[mcp_servers.demo]\nurl="https://example.com/mcp"\n'
                      '[mcp_servers.demo.http_headers]\nAuthorization="Bearer scan-secret"\n')
    before = source.read_bytes()
    items = scan_local(home)
    assert len(items) == 1
    assert 'scan-secret' not in json.dumps(items)
    assert source.read_bytes() == before
    assert items[0]['requires_credentials'] is True


def test_empty_runtime_keeps_original_kwargs(tmp_path, monkeypatch):
    from services.connectors import runtime
    from services.conversation_context import conversation_context
    monkeypatch.setattr(runtime, 'connector_store', make_store(tmp_path))
    kwargs = {'prompt': 'hello', 'config_overrides': {'model': 'original'}}
    with conversation_context('p', 's'):
        result = asyncio.run(runtime.prepare('codex', kwargs))
    assert result is kwargs


def test_runtime_uses_secret_free_bridge_and_scope(tmp_path, monkeypatch):
    from services.connectors import runtime
    from services.conversation_context import conversation_context
    store = make_store(tmp_path)
    monkeypatch.setattr(runtime, 'connector_store', store)
    item = store.save({**definition(), 'headers': {'Authorization': 'upstream-private-test-token'}})
    store.select('p', 's', [item['id']])
    kwargs = {'prompt': 'hello', 'config_overrides': {'model': 'original'}}
    with conversation_context('p', 's'):
        prepared = asyncio.run(runtime.prepare('codex', kwargs))
    assert 'upstream-private-test-token' not in json.dumps(prepared)
    assert kwargs['config_overrides'] == {'model': 'original'}
    assert prepared['config_overrides']['model'] == 'original'
    assert len(prepared['config_overrides']['mcp_servers']) == 1


@pytest.mark.asyncio
async def test_api_slow_storage_does_not_block_loop(tmp_path, monkeypatch):
    import time
    from api import connectors
    store = make_store(tmp_path)
    monkeypatch.setattr(connectors, 'connector_store', store)
    original = store.list
    def slow():
        time.sleep(.15)
        return original()
    monkeypatch.setattr(store, 'list', slow)
    app = FastAPI()
    app.include_router(connectors.router)
    @app.get('/health')
    async def health():
        return {'ok': True}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        pending = asyncio.create_task(client.get('/api/connectors'))
        await asyncio.sleep(.02)
        assert not pending.done()
        assert (await asyncio.wait_for(client.get('/health'), .08)).status_code == 200
        assert (await pending).status_code == 200


@pytest.mark.asyncio
async def test_api_host_management_and_project_selection_boundaries(tmp_path, monkeypatch):
    from api import connectors
    from services.remote_access import ActorSnapshot, actor_context
    store = make_store(tmp_path)
    monkeypatch.setattr(connectors, 'connector_store', store)
    item = store.save({**definition(), 'project_ids': ['p1']})
    app = FastAPI()
    app.include_router(connectors.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        body = {'project_id': 'p1', 'session_id': 's', 'connector_ids': [item['id']]}
        host = ActorSnapshot('host', 'Host', 'device', 'Device', 'local')
        with actor_context(host):
            assert (await client.put('/api/connectors/selection', json=body)).status_code == 200
        for access in ['read', 'edit']:
            actor = ActorSnapshot('remote', 'Remote', 'device', 'Device', 'remote', project_id='p1', access_level=access)
            with actor_context(actor):
                assert (await client.get('/api/connectors')).status_code == 403
                assert (await client.post('/api/connectors/scan')).status_code == 403
                assert (await client.put('/api/connectors/selection', json=body)).status_code == (200 if access == 'edit' else 403)
                assert (await client.get('/api/connectors/available?project_id=p2')).status_code == 403
                response = await client.get('/api/connectors/available?project_id=p1&session_id=s&engine_id=unknown')
                assert response.status_code == 200
                assert response.json()['connectors'][0]['available'] is False
                assert 'url' not in response.json()['connectors'][0]


@pytest.mark.asyncio
async def test_real_stdio_bridge_call_and_immediate_scope_revocation(tmp_path):
    """Exercise native MCP framing, subprocess execution and per-call scope checks."""
    import sys
    from services.connectors.runtime import bridge_server
    from services.connectors.transport import connect
    store = make_store(tmp_path)
    item = store.save({'name': 'Python CLI', 'kind': 'cli', 'command': sys.executable,
                       'args': ['-c', 'import sys; print("hello " + sys.argv[1])'], 'project_ids': ['p']})
    store.select('p', 's', [item['id']])
    bridge = {**bridge_server(store, item, 'p', 's'), 'transport': 'stdio'}
    async with connect(bridge) as client:
        assert [tool.name for tool in (await client.list_tools()).tools] == ['run']
        result = await client.call_tool('run', {'arguments': ['connector']})
        assert not result.isError
        assert 'hello connector' in result.content[0].text
        await asyncio.to_thread(store.save, {**item, 'project_ids': ['other']})
        denied = await client.call_tool('run', {'arguments': ['forbidden']})
        assert denied.isError
        assert 'forbidden' not in denied.content[0].text


def test_engine_mcp_adapters_preserve_native_configuration(tmp_path):
    import tomllib
    from services.connectors.runtime import acp_servers, native_servers, codex_settings, claude_mcp_config
    servers = [{'name': 'workstep_test', 'command': '/python', 'args': ['bridge.py'], 'env': {'KEY': 'metadata'}}]
    config = {'mcp_servers': servers}
    assert acp_servers(servers)[0].env[0].name == 'KEY'
    assert native_servers(config)['workstep_test']['command'] == '/python'
    parsed = {}
    for setting in codex_settings(config):
        value = tomllib.loads(setting)
        parsed.update(value['mcp_servers']['workstep_test'])
    assert parsed == native_servers(config)['workstep_test']
    assert json.loads(claude_mcp_config(config))['mcpServers'] == native_servers(config)


@pytest.mark.asyncio
async def test_task_scope_survives_idle_timeout_tasks_without_leaking_context(tmp_path, monkeypatch):
    from services.connectors import runtime
    from services.conversation_context import current_conversation
    store = make_store(tmp_path)
    monkeypatch.setattr(runtime, 'connector_store', store)
    item = store.save(definition())
    store.select('project', 'task:one', [item['id']])
    observed = []
    before = current_conversation()
    async def engine():
        for _ in range(2):
            observed.append(current_conversation())
            yield 'event'
    iterator = runtime.scoped_task_stream(engine(), 'project', 'one')
    assert await asyncio.wait_for(anext(iterator), 1) == 'event'
    assert await asyncio.wait_for(anext(iterator), 1) == 'event'
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(anext(iterator), 1)
    assert observed == [{'project_id': 'project', 'session_id': 'task:one'}] * 2
    assert current_conversation() == before


@pytest.mark.asyncio
async def test_pydantic_connector_rechecks_scope_after_approval(tmp_path, monkeypatch):
    from services.connectors import pydantic_tools
    from services.conversation_context import conversation_context
    store = make_store(tmp_path)
    monkeypatch.setattr(pydantic_tools, 'connector_store', store)
    item = store.save({'name': 'CLI', 'kind': 'cli', 'command': 'never-execute', 'project_ids': ['p']})
    store.select('p', 's', [item['id']])
    class Engine:
        async def _request_permission(self, *args, **kwargs):
            await asyncio.to_thread(store.save, {**item, 'project_ids': ['other']})
            return True
    with conversation_context('p', 's'):
        tools = pydantic_tools.ConnectorTools(Engine(), str(tmp_path), None)
        with pytest.raises(PermissionError):
            await tools.call_tool(item['id'], 'run', {'arguments': []})


@pytest.mark.asyncio
async def test_bridge_forwards_real_mcp_tools_and_results(tmp_path):
    import sys
    from services.connectors.runtime import bridge_server
    from services.connectors.transport import connect, probe
    upstream = tmp_path / 'upstream.py'
    upstream.write_text('from mcp.server.fastmcp import FastMCP\n'
                        'app = FastMCP("fixture")\n'
                        '@app.tool()\ndef echo(text: str) -> str:\n    return "echo: " + text\n'
                        'app.run(transport="stdio")\n')
    store = make_store(tmp_path)
    item = store.save({'name': 'MCP fixture', 'kind': 'mcp', 'transport': 'stdio',
                       'command': sys.executable, 'args': [str(upstream)]})
    store.select('p', 's', [item['id']])
    private = store.resolve(item['id'])
    assert (await probe(private))['tool_count'] == 1
    async with connect({**bridge_server(store, item, 'p', 's'), 'transport': 'stdio'}) as client:
        tools = await client.list_tools()
        assert tools.tools[0].name == 'echo'
        assert 'text' in tools.tools[0].inputSchema['properties']
        result = await client.call_tool('echo', {'text': 'connected'})
        assert not result.isError
        assert result.content[0].text == 'echo: connected'
