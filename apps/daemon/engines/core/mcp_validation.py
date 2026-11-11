"""Real MCP round-trip acceptance, independent of adapter-authored assertions."""
import asyncio
from pathlib import Path
import shutil
import sys
import tempfile
import uuid

from services.config import config_store


async def validate_mcp_connector(engine, cwd: str, observe=None):
    """Require the engine to invoke an isolated probe, also after resume.

    A text claim or a synthetic tool event is insufficient: the private test
    service must write the nonce receipt. All fixture I/O stays off-loop.
    """
    root = Path(await asyncio.to_thread(tempfile.mkdtemp, prefix='mcp-probe-', dir=cwd))
    receipt = root / 'receipt.txt'
    tool_name = 'workstep_mcp_probe_' + uuid.uuid4().hex[:12]
    script = root / 'server.py'
    code = f'''import asyncio
from pathlib import Path
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
server = FastMCP("workstep_validation")
@server.tool(name={tool_name!r}, annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False))
async def probe(nonce: str) -> dict:
    """Return the supplied nonce for WorkStep connector validation."""
    await asyncio.to_thread(Path({str(receipt)!r}).write_text, nonce, encoding="utf-8")
    return {{"nonce": nonce}}
server.run(transport="stdio")
'''
    try:
        await asyncio.to_thread(script.write_text, code, encoding='utf-8')
        servers = [{'name': 'workstep_validation', 'command': sys.executable, 'args': [str(script)], 'env': {}}]
        model, provider = await asyncio.to_thread(lambda: (
            config_store.get_engine_default_model(engine.ENGINE_ID),
            config_store.get_engine_provider(engine.ENGINE_ID),
        ))
        session_id = None
        for turn in range(2 if engine.supports_resume else 1):
            nonce = uuid.uuid4().hex
            await asyncio.to_thread(receipt.unlink, missing_ok=True)
            base_config = {'provider_id': provider} if provider else {}
            configured = await engine.configure_mcp_servers(servers, base_config)
            if not isinstance(configured, dict):
                raise AssertionError('MCP 配置接口未返回字典')
            kwargs = {'config_overrides': configured, 'model': model or None}
            if turn:
                if not session_id:
                    raise AssertionError('MCP 恢复探测缺少真实会话 ID')
                kwargs['session_id'] = session_id
            prompt = (f'Use only the MCP tool {tool_name} from server workstep_validation. '
                      f'Call it with nonce={nonce} (the nonce argument must be exactly that value), '
                      'then report its returned nonce. Do not use shell, filesystem, other tools, '
                      'or create/edit files yourself.')
            chunks = []
            async for event in engine.spawn(prompt=prompt, cwd=cwd, **kwargs):
                if observe:
                    observe(event)
                if event.type == 'error':
                    raise AssertionError('MCP 引擎调用失败')
                if event.type == 'session_started':
                    actual = event.data['session_id']
                    if turn and actual != session_id:
                        raise AssertionError('MCP 探测未恢复原生会话')
                    session_id = actual
                if event.type == 'agent_message_chunk':
                    chunks.append(event.data['content']['text'])
                if event.type == 'interaction_request':
                    call = event.data.get('tool_call') or {}
                    name = str(call.get('name') or call.get('title') or '')
                    option = next((option for option in event.data.get('options', [])
                                   if option.get('kind') == 'allow_once'), None)
                    if not name.endswith(tool_name) or not option:
                        await engine.respond_interaction(event.data, {'outcome': {'outcome': 'cancelled'}})
                        raise AssertionError('MCP 探测请求了非测试工具或无法单次批准')
                    await engine.approve_tool_option(event.data['interaction_id'], option['option_id'])
            received = await asyncio.to_thread(lambda: receipt.is_file() and receipt.read_text(encoding='utf-8') == nonce)
            if not received or not ''.join(chunks).strip():
                raise AssertionError('MCP 服务未收到真实调用，不能仅凭文本或事件宣称支持')
    finally:
        try:
            await engine.stop()
        finally:
            await asyncio.to_thread(shutil.rmtree, root, ignore_errors=True)
