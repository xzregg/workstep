"""Private stdio MCP bridge. Adapter command lines contain IDs, never credentials."""
import asyncio
import os
import sys
from pathlib import Path

if __package__ in {None, ''}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from services.connectors.store import ConnectorStore
from services.connectors.transport import connect, run_cli


async def serve():
    from mcp.server import Server
    from mcp.server.stdio import stdio_server
    from mcp import types
    store = ConnectorStore(Path(os.environ['WORKSTEP_CONNECTOR_DIRECTORY']))
    identifier = os.environ['WORKSTEP_CONNECTOR_ID']
    project = os.environ['WORKSTEP_CONNECTOR_PROJECT']
    session_id = os.environ['WORKSTEP_CONNECTOR_SESSION']

    async def checked():
        items = await asyncio.to_thread(store.selected, project, session_id)
        item = next((i for i in items if i['id'] == identifier), None)
        if item is None:
            raise PermissionError('连接器已停用或不在当前项目范围内')
        return item

    item = await checked()
    server = Server('workstep-connector-' + identifier)
    if item['kind'] == 'cli':
        @server.list_tools()
        async def list_tools():
            await checked()
            return [types.Tool(name='run', description=item['name'] + ': ' + item.get('description', ''),
                               inputSchema={'type': 'object', 'properties': {'arguments': {'type': 'array', 'items': {'type': 'string'}}}, 'required': ['arguments']})]

        @server.call_tool()
        async def call_tool(name, arguments):
            if name != 'run':
                raise ValueError('未知工具')
            current = await checked()
            import json
            result = await run_cli(current, arguments.get('arguments', []), os.environ.get('WORKSTEP_CONNECTOR_CWD'))
            return [types.TextContent(type='text', text=json.dumps(result, ensure_ascii=False))]

        async with stdio_server() as (read, write):
            await server.run(read, write, server.create_initialization_options())
    else:
        async with connect(item) as upstream:
            @server.list_tools()
            async def list_tools():
                await checked()
                try:
                    return (await upstream.list_tools()).tools
                except Exception:
                    raise ValueError('无法读取连接器工具，请检查连接设置') from None

            @server.call_tool()
            async def call_tool(name, arguments):
                current = await checked()
                if current['revision'] != item['revision']:
                    raise ValueError('连接器配置已更新，请开始新一轮执行')
                try:
                    return await upstream.call_tool(name, arguments)
                except Exception:
                    raise ValueError('连接器调用失败，请检查连接状态') from None

            async with stdio_server() as (read, write):
                await server.run(read, write, server.create_initialization_options())


if __name__ == '__main__':
    try:
        asyncio.run(serve())
    except Exception:
        print('WorkStep connector unavailable; check connection settings.', file=sys.stderr)
        sys.exit(1)
