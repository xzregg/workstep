"""Acceptance requires an observed MCP call, including on resumed sessions."""
import re

import pytest

from engines.core.events import InternalEvent, agent_message_chunk


class ProbeAdapter:
    ENGINE_ID = 'probe_adapter'
    supports_mcp = True
    supports_resume = True
    def __init__(self, *, ignore=False, drop_on_resume=False):
        self.ignore, self.drop_on_resume = ignore, drop_on_resume
        self.configurations, self.sessions = [], []
    async def configure_mcp_servers(self, servers, config_overrides=None):
        self.configurations.append(servers)
        return {**(config_overrides or {}), 'native_servers': servers}
    async def spawn(self, prompt, cwd, session_id=None, config_overrides=None, **kwargs):
        self.sessions.append(session_id)
        yield InternalEvent('session_started', {'session_id': 'real-probe-session'})
        if not self.ignore and not (session_id and self.drop_on_resume):
            from services.connectors.transport import connect
            server = config_overrides['native_servers'][0]
            async with connect({**server, 'transport': 'stdio'}) as client:
                tools = (await client.list_tools()).tools
                result = await client.call_tool(tools[0].name, {'nonce': re.search(r'nonce=([a-f0-9]+)', prompt).group(1)})
                assert not result.isError
                yield InternalEvent('tool_call', {'tool_call_id': 'probe', 'title': tools[0].name})
                yield agent_message_chunk(result.content[0].text)
        else:
            yield agent_message_chunk('I support MCP, everything succeeded')
    async def stop(self): pass


@pytest.mark.asyncio
async def test_mcp_acceptance_calls_adapter_and_real_server_for_new_and_resumed_session(tmp_path):
    from engines.core.mcp_validation import validate_mcp_connector
    adapter = ProbeAdapter()
    await validate_mcp_connector(adapter, str(tmp_path))
    assert adapter.sessions == [None, 'real-probe-session']
    assert len(adapter.configurations) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize('kwargs', [{'ignore': True}, {'drop_on_resume': True}])
async def test_mcp_acceptance_rejects_claims_without_actual_tool_call(tmp_path, kwargs):
    from engines.core.mcp_validation import validate_mcp_connector
    with pytest.raises(AssertionError):
        await validate_mcp_connector(ProbeAdapter(**kwargs), str(tmp_path))


@pytest.mark.asyncio
async def test_slow_probe_filesystem_keeps_event_loop_responsive(tmp_path, monkeypatch):
    import asyncio
    import time
    from engines.core import mcp_validation
    original = mcp_validation.tempfile.mkdtemp
    def slow(*args, **kwargs):
        time.sleep(.15)
        return original(*args, **kwargs)
    monkeypatch.setattr(mcp_validation.tempfile, 'mkdtemp', slow)
    async def verify_failure():
        with pytest.raises(AssertionError):
            await mcp_validation.validate_mcp_connector(ProbeAdapter(ignore=True), str(tmp_path))
    pending = asyncio.create_task(verify_failure())
    await asyncio.sleep(.02)
    assert not pending.done()
    assert await asyncio.wait_for(asyncio.sleep(0, result='responsive'), .08) == 'responsive'
    await pending


class PermissionAdapter(ProbeAdapter):
    def __init__(self, *, wrong_tool=False, no_once=False):
        super().__init__()
        self.wrong_tool, self.no_once = wrong_tool, no_once
        self.approved, self.declined = [], []
    async def spawn(self, prompt, cwd, config_overrides=None, **kwargs):
        from services.connectors.transport import connect
        async with connect({**config_overrides['native_servers'][0], 'transport': 'stdio'}) as client:
            name = (await client.list_tools()).tools[0].name
        yield InternalEvent('interaction_request', {'interaction_id': 'probe-approval',
            'tool_call': {'name': 'shell' if self.wrong_tool else name},
            'options': [{'option_id': 'always', 'kind': 'allow_always'}] if self.no_once else [
                {'option_id': 'once', 'kind': 'allow_once'}, {'option_id': 'always', 'kind': 'allow_always'}]})
        async for event in super().spawn(prompt, cwd, config_overrides=config_overrides, **kwargs):
            yield event
    async def approve_tool_option(self, interaction_id, option_id):
        self.approved.append((interaction_id, option_id))
    async def respond_interaction(self, data, response):
        self.declined.append(response)


@pytest.mark.asyncio
async def test_probe_approval_only_allows_once_for_its_own_tool(tmp_path):
    from engines.core.mcp_validation import validate_mcp_connector
    adapter = PermissionAdapter()
    await validate_mcp_connector(adapter, str(tmp_path))
    assert adapter.approved == [('probe-approval', 'once')] * 2
    assert adapter.declined == []


@pytest.mark.asyncio
@pytest.mark.parametrize('kwargs', [{'wrong_tool': True}, {'no_once': True}])
async def test_probe_never_approves_unrelated_tools_or_persistent_permissions(tmp_path, kwargs):
    from engines.core.mcp_validation import validate_mcp_connector
    adapter = PermissionAdapter(**kwargs)
    with pytest.raises(AssertionError):
        await validate_mcp_connector(adapter, str(tmp_path))
    assert adapter.approved == []
    assert adapter.declined == [{'outcome': {'outcome': 'cancelled'}}]
    assert adapter.sessions == []
