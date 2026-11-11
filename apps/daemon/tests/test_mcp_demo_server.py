"""Run the reusable manual demo through the same transports as connectors."""
import json
from pathlib import Path
import sys

import pytest

DEMO = Path(__file__).resolve().parents[3] / 'scripts' / 'mcp_demo_server.py'


def definition():
    return {'name': 'MCP 本地测试', 'kind': 'mcp', 'transport': 'stdio',
            'command': sys.executable, 'args': [str(DEMO)],
            'env': {'WORKSTEP_MCP_DEMO_LABEL': '连接器测试'}}


def output(result):
    assert not result.isError
    return json.loads(result.content[0].text)


@pytest.mark.asyncio
async def test_demo_can_discover_and_call_all_three_tools():
    from services.connectors.transport import connect, probe
    assert DEMO.is_file()
    assert (await probe(definition())) == {'ok': True, 'tool_count': 3, 'message': '已连接 MCP 服务'}
    async with connect(definition()) as client:
        assert {tool.name for tool in (await client.list_tools()).tools} == {'echo', 'add', 'get_demo_info'}
        assert output(await client.call_tool('echo', {'message': '你好，MCP'})) == {'echo': '你好，MCP'}
        assert output(await client.call_tool('add', {'a': 12, 'b': 30})) == {'result': 42}
        assert output(await client.call_tool('get_demo_info', {})) == {'name': 'WorkStep MCP Demo', 'label': '连接器测试', 'tool_count': 3}


@pytest.mark.asyncio
async def test_demo_is_callable_through_project_scoped_connector_bridge(tmp_path):
    from services.connectors.store import ConnectorStore
    from services.connectors.runtime import bridge_server
    from services.connectors.transport import connect
    store = ConnectorStore(tmp_path / 'connectors')
    item = store.save({**definition(), 'project_ids': ['demo-project']})
    store.select('demo-project', 'demo-session', [item['id']])
    async with connect({**bridge_server(store, item, 'demo-project', 'demo-session'), 'transport': 'stdio'}) as client:
        assert len((await client.list_tools()).tools) == 3
        assert output(await client.call_tool('add', {'a': 20, 'b': 22})) == {'result': 42}
