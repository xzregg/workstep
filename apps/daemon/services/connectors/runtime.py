"""Secret-free engine configuration. Inactive connectors leave kwargs untouched."""
import asyncio
import sys
from pathlib import Path

from services.connectors.store import connector_store
from services.conversation_context import current_conversation

def engine_supports_mcp(engine_id):
    """Read declared capability, including freshly registered custom engines.

    Registry reads/engine construction run in the caller's worker thread.
    """
    from engines.core.registry import list_all_engines
    cls = list_all_engines().get(engine_id)
    return bool(cls and cls().supports_mcp)


def bridge_server(store, item, project_id, session_id):
    return {'name': 'workstep_' + item['id'], 'command': sys.executable,
            'args': [str(Path(__file__).with_name('bridge.py'))],
            'env': {'WORKSTEP_CONNECTOR_DIRECTORY': str(store.directory),
                    'WORKSTEP_CONNECTOR_ID': item['id'],
                    'WORKSTEP_CONNECTOR_PROJECT': project_id,
                    'WORKSTEP_CONNECTOR_SESSION': session_id}}


async def prepare(engine, kwargs):
    identity = current_conversation()
    if not identity.get('project_id') or not identity.get('session_id'):
        return kwargs
    selected = await asyncio.to_thread(connector_store.selected, identity['project_id'], identity['session_id'])
    if not selected:
        return kwargs
    if isinstance(engine, str):
        from engines.core.registry import list_all_engines
        cls = await asyncio.to_thread(lambda: list_all_engines().get(engine))
        engine = await asyncio.to_thread(cls) if cls else None
    if engine is None or not engine.supports_mcp:
        raise ValueError('当前引擎尚未支持连接器，请关闭连接器或切换引擎')
    servers = [bridge_server(connector_store, item, identity['project_id'], identity['session_id']) for item in selected]
    for server in servers:
        if kwargs.get('cwd'):
            server['env']['WORKSTEP_CONNECTOR_CWD'] = str(kwargs['cwd'])
    overrides = await engine.configure_mcp_servers(servers, kwargs.get('config_overrides'))
    if not isinstance(overrides, dict):
        raise ValueError('引擎 configure_mcp_servers 必须返回配置字典')
    return {**kwargs, 'config_overrides': overrides}


def native_servers(overrides):
    return {s['name']: {k: v for k, v in s.items() if k != 'name'}
            for s in (overrides or {}).get('mcp_servers', []) if isinstance(s, dict)}


def acp_servers(servers):
    from acp import schema
    return [schema.McpServerStdio(name=s['name'], command=s['command'], args=s.get('args', []),
                                env=[schema.EnvVariable(name=k, value=v) for k, v in s.get('env', {}).items()])
            if isinstance(s, dict) and s.get('command') else s for s in servers]


def codex_settings(overrides):
    import json
    result = []
    for name, server in native_servers(overrides).items():
        for key, value in server.items():
            encoded = ('{ ' + ', '.join(f'{json.dumps(k)} = {json.dumps(v)}' for k, v in value.items()) + ' }'
                       if isinstance(value, dict) else json.dumps(value))
            result.append(f'mcp_servers.{name}.{key}={encoded}')
    return result


def claude_mcp_config(overrides):
    """Claude accepts inline JSON; only bridge metadata reaches its arguments."""
    import json
    servers = native_servers(overrides)
    return json.dumps({'mcpServers': servers}) if servers else None


async def scoped_task_stream(iterator, project_id, task_id):
    # Do not change legacy execution context when no connector was selected.
    selected = await asyncio.to_thread(connector_store.selected, project_id, 'task:' + task_id) if project_id else []
    if not selected:
        async for event in iterator:
            yield event
        return
    from services.conversation_context import conversation_context
    try:
        while True:
            with conversation_context(project_id, 'task:' + task_id):
                try:
                    event = await iterator.__anext__()
                except StopAsyncIteration:
                    return
            yield event
    finally:
        with conversation_context(project_id, 'task:' + task_id):
            await iterator.aclose()
