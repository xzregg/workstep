"""MCP capability discovery and the opt-in adapter interface."""
from copy import deepcopy

import pytest


@pytest.mark.parametrize('engine_id,expected', [
    ('claude', True), ('claude_agent_sdk', True), ('codex', True), ('codex_sdk', True),
    ('qoder_sdk', True), ('hermes', True), ('opencode', True), ('pydantic_ai', True),
    ('openclaw', False), ('deepseek_harness', False), ('cursor', False),
])
def test_builtin_engines_declare_actual_mcp_support(engine_id, expected):
    from engines.core.registry import list_all_engines
    cls = list_all_engines()[engine_id]
    engine = cls()
    assert engine.supports_mcp is expected
    assert engine.capabilities.supports_mcp is expected
    assert callable(engine.configure_mcp_servers)


@pytest.mark.asyncio
async def test_adapter_method_merges_without_mutating_existing_configuration():
    from engines.codex import CodexEngine
    original = {'model': 'original', 'mcp_servers': [{'name': 'native', 'command': 'native-command'}]}
    servers = [{'name': 'workstep_demo', 'command': '/python', 'args': ['bridge.py'], 'env': {'ID': 'demo'}}]
    before = deepcopy((original, servers))
    configured = await CodexEngine().configure_mcp_servers(servers, original)
    assert configured['model'] == 'original'
    assert [server['name'] for server in configured['mcp_servers']] == ['native', 'workstep_demo']
    configured['mcp_servers'][1]['env']['ID'] = 'changed'
    assert (original, servers) == before
    with pytest.raises(ValueError, match='冲突'):
        await CodexEngine().configure_mcp_servers([{'name': 'native'}], original)


@pytest.mark.asyncio
async def test_unsupported_engine_rejects_mcp_configuration():
    from engines.openclaw import OpenClawEngine
    with pytest.raises(NotImplementedError):
        await OpenClawEngine().configure_mcp_servers([{'name': 'test', 'command': '/python'}])


@pytest.mark.asyncio
async def test_runtime_calls_custom_adapter_instead_of_engine_id_allowlist(tmp_path, monkeypatch):
    from services.connectors import runtime
    from services.connectors.store import ConnectorStore
    from services.conversation_context import conversation_context
    from engines.core.acp_base import AcpEngineBase
    from engines.codex import CodexEngine
    class Custom(CodexEngine):
        ENGINE_ID = 'brand_new_custom'
        supports_mcp = True
        async def configure_mcp_servers(self, servers, config_overrides=None):
            return {**(config_overrides or {}), 'sdk_mcp_servers': servers}
    store = ConnectorStore(tmp_path / 'connectors')
    monkeypatch.setattr(runtime, 'connector_store', store)
    item = store.save({'name': 'Demo', 'command': '/python', 'args': ['demo.py']})
    store.select('p', 's', [item['id']])
    engine = Custom()
    kwargs = {'cwd': str(tmp_path), 'config_overrides': {'model': 'original'}}
    with conversation_context('p', 's'):
        configured = await runtime.prepare(engine, kwargs)
    assert configured['config_overrides']['model'] == 'original'
    assert configured['config_overrides']['sdk_mcp_servers'][0]['name'] == 'workstep_' + item['id']
    assert kwargs['config_overrides'] == {'model': 'original'}


@pytest.mark.asyncio
async def test_execution_hook_handles_decorated_spawn_without_injecting_readonly_coordinator(tmp_path, monkeypatch):
    from engines.codex import CodexEngine
    from engines.core.events import agent_message_chunk
    from services.connectors import runtime
    from services.connectors.store import ConnectorStore
    from services.conversation_context import conversation_context
    store = ConnectorStore(tmp_path / 'connectors')
    monkeypatch.setattr(runtime, 'connector_store', store)
    item = store.save({'name': 'Demo', 'command': '/python'})
    store.select('p', 's', [item['id']])
    captured = []
    async def decorated_stream(self, **kwargs):
        captured.append(kwargs)
        yield agent_message_chunk('ok')
    class Decorated(CodexEngine):
        ENGINE_ID = 'decorated_custom'
        spawn = decorated_stream
        async def spawn_coordinator(self, **kwargs):
            captured.append(kwargs)
            yield agent_message_chunk('readonly')
    engine = Decorated()
    with conversation_context('p', 's'):
        assert [event async for event in engine.spawn_with_retry(prompt='hello', cwd='')]
        assert [event async for event in engine.spawn_coordinator_with_retry(prompt='readonly', cwd='')]
    assert len(captured[0]['config_overrides']['mcp_servers']) == 1
    assert not (captured[1].get('config_overrides') or {}).get('mcp_servers')
