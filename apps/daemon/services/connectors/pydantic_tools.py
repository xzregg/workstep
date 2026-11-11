"""Expose connector discovery/calls through Pydantic AI's normal approval path."""
import asyncio
from services.connectors.store import connector_store
from services.connectors.transport import connect, run_cli
from services.conversation_context import current_conversation


class ConnectorTools:
    def __init__(self, engine, cwd, on_event):
        self.engine, self.cwd, self.on_event = engine, cwd, on_event

    async def items(self):
        identity = current_conversation()
        if not identity.get('project_id'):
            return []
        return await asyncio.to_thread(connector_store.selected, identity['project_id'], identity['session_id'])

    async def list_tools(self) -> list[dict]:
        """List enabled connectors and their tools, including JSON input schemas."""
        result = []
        for item in await self.items():
            if item['kind'] == 'cli':
                tools = [{'name': 'run', 'description': item['description'], 'inputSchema': {
                    'type': 'object', 'properties': {'arguments': {'type': 'array', 'items': {'type': 'string'}}}, 'required': ['arguments']}}]
            else:
                try:
                    async with connect(item) as client:
                        tools = [tool.model_dump(mode='json', exclude_none=True) for tool in (await client.list_tools()).tools]
                except Exception:
                    tools = []
            result.append({'connector_id': item['id'], 'name': item['name'], 'tools': tools})
        return result

    async def call_tool(self, connector_id: str, tool_name: str, arguments: dict) -> dict:
        """Call a discovered connector tool. Never pass credentials in arguments."""
        item = next((i for i in await self.items() if i['id'] == connector_id), None)
        if item is None:
            raise PermissionError('连接器已停用或项目未获授权')
        allowed = await self.engine._request_permission(
            self.on_event, tool_name='connector:' + connector_id + ':' + tool_name,
            title=item['name'] + ': ' + tool_name, kind='other', tool_input=arguments,
        )
        if not allowed:
            return {'error': '用户拒绝执行'}
        current = next((i for i in await self.items() if i['id'] == connector_id), None)
        if current is None:
            raise PermissionError('连接器已停用或项目未获授权')
        if current['revision'] != item['revision']:
            raise PermissionError('连接器配置已更新，请重新调用')
        if item['kind'] == 'cli':
            if tool_name != 'run':
                raise ValueError('未知 CLI 工具')
            return await run_cli(item, arguments.get('arguments', []), self.cwd)
        try:
            async with connect(item) as client:
                result = await client.call_tool(tool_name, arguments)
                return result.model_dump(mode='json', exclude_none=True)
        except Exception:
            return {'error': '连接器调用失败，请检查连接状态'}
