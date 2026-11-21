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
            raise PermissionError('Connector is disabled or not within the current project scope')
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
                raise ValueError('Unknown tool')
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
                    raise ValueError('Unable to read connector tool, please check connection settings:') from None

            @server.call_tool()
            async def call_tool(name, arguments):
                current = await checked()
                if current['revision'] != item['revision']:
                    raise ValueError('Connector configuration has been updated. Please start a new execution round.')
                try:
                    return await upstream.call_tool(name, arguments)
                except Exception:
                    raise ValueError('Connector call failed, please check the connection status') from None

            async with stdio_server() as (read, write):
                await server.run(read, write, server.create_initialization_options())


if __name__ == '__main__':
    try:
        asyncio.run(serve())
    except Exception:
        print('WorkStep connector unavailable; check connection settings.', file=sys.stderr)
        sys.exit(1)
