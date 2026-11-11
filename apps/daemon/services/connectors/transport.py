"""MCP/CLI transports, shared by the private bridge and explicit connection tests."""
import asyncio
import os
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import timedelta


@asynccontextmanager
async def connect(item):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    from mcp.client.sse import sse_client
    from mcp.client.streamable_http import streamablehttp_client
    async with AsyncExitStack() as stack:
        if item['transport'] == 'stdio':
            log = await asyncio.to_thread(open, os.devnull, 'w')
            stack.callback(log.close)
            stream = await stack.enter_async_context(stdio_client(StdioServerParameters(
                command=item['command'], args=item.get('args', []),
                env={**os.environ, **item.get('env', {})},
            ), errlog=log))
        elif item['transport'] == 'sse':
            stream = await stack.enter_async_context(sse_client(item['url'], headers=item.get('headers'), timeout=15))
        else:
            stream = await stack.enter_async_context(streamablehttp_client(item['url'], headers=item.get('headers'), timeout=15))
        session = await stack.enter_async_context(ClientSession(stream[0], stream[1], read_timeout_seconds=timedelta(seconds=30)))
        await session.initialize()
        yield session


async def run_cli(item, arguments, cwd=None):
    if not isinstance(arguments, list) or len(arguments) > 100 or any(not isinstance(a, str) or len(a) > 8192 for a in arguments):
        raise ValueError('CLI 参数无效')
    process = await asyncio.create_subprocess_exec(
        item['command'], *item.get('args', []), *arguments,
        cwd=cwd, env={**os.environ, **item.get('env', {})},
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    try:
        from engines.core.stream_lines import iter_stream_lines
        parts, size = [], 0
        async with asyncio.timeout(60):
            async for line in iter_stream_lines(process.stdout):
                size += len(line)
                if size > 1024 * 1024:
                    raise ValueError('CLI 输出超过限制')
                parts.append(line.decode(errors='replace') if isinstance(line, bytes) else line)
            await process.wait()
        return {'exit_code': process.returncode, 'output': '\n'.join(parts)}
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def probe(item):
    result = await diagnose(item, include_tools=False)
    return {key: result[key] for key in ('ok', 'message', 'tool_count')}


def _failure(exc):
    """Classify nested transport errors without disclosing their messages/URLs."""
    import httpx
    pending, seen = [exc], set()
    timeout = False
    while pending:
        error = pending.pop()
        if id(error) in seen:
            continue
        seen.add(id(error))
        pending.extend(getattr(error, 'exceptions', ()))
        pending.extend(e for e in (error.__cause__, error.__context__) if e is not None)
        if isinstance(error, httpx.HTTPStatusError) and error.response.status_code in {401, 403}:
            status = 'auth_required' if error.response.status_code == 401 else 'forbidden'
            scheme = error.response.headers.get('www-authenticate', '').split(' ', 1)[0].lower()
            return {'ok': False, 'status': status, 'tool_count': 0, 'tools': [],
                    'auth_scheme': scheme if scheme in {'bearer', 'basic'} else 'unknown',
                    'message': '需要认证或凭据已过期，请配置认证后重试' if status == 'auth_required' else '访问被拒绝，请检查账号权限、授权范围和服务访问策略'}
        timeout = timeout or isinstance(error, (TimeoutError, httpx.TimeoutException))
    return {'ok': False, 'status': 'timeout' if timeout else 'error', 'tool_count': 0, 'tools': [],
            'message': '连接超时，请检查服务状态后重试' if timeout else '连接失败，请检查地址、安装状态和认证信息'}


def _redact(value, item):
    secrets = [secret for group in ('headers', 'env') for secret in item.get(group, {}).values() if len(secret) >= 4]
    secrets += [secret[7:] for secret in secrets if secret.lower().startswith('bearer ') and len(secret) > 10]
    def clean(part):
        if isinstance(part, str):
            for secret in sorted(secrets, key=len, reverse=True):
                part = part.replace(secret, '[redacted]')
            return part
        if isinstance(part, list):
            return [clean(p) for p in part]
        if isinstance(part, dict):
            return {clean(k): clean(v) for k, v in part.items()}
        return part
    return clean(value)


async def diagnose(item, *, tool_name=None, arguments=None, include_tools=True):
    invoking = False
    try:
        if item['kind'] == 'cli':
            import shutil
            installed = await asyncio.to_thread(shutil.which, item['command'])
            return {'ok': bool(installed), 'tool_count': 1 if installed else 0,
                    'status': 'cli_available' if installed else 'error', 'tools': [],
                    'message': 'CLI 已安装，登录状态由 CLI 管理' if installed else '未找到 CLI 可执行文件'}
        async with asyncio.timeout(35):
            async with connect(item) as client:
                tools, cursor = [], None
                for _ in range(10):
                    page = await client.list_tools(cursor=cursor)
                    tools.extend(page.tools)
                    cursor = page.nextCursor
                    if not cursor:
                        break
                result = {'ok': True, 'status': 'connected', 'tool_count': len(tools),
                          'message': '已连接 MCP 服务', 'tools': [], 'has_more': bool(cursor)}
                if include_tools:
                    result['tools'] = [{'name': tool.name, 'description': tool.description or '', 'input_schema': tool.inputSchema} for tool in tools]
                if tool_name is not None:
                    if tool_name not in {tool.name for tool in tools}:
                        return {'ok': False, 'status': 'error', 'tool_count': len(tools), 'tools': [], 'message': '工具已变化或不存在，请重新测试连接'}
                    invoking = True
                    output = await client.call_tool(tool_name, arguments or {})
                    result.update(ok=not output.isError, status='tool_error' if output.isError else 'connected',
                                  message='工具执行失败' if output.isError else '工具执行完成', result=output.model_dump(mode='json', by_alias=True))
                return _redact(result, item)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        failure = _failure(exc)
        if invoking and failure['status'] == 'error':
            failure.update(status='tool_error', message='工具调用失败，请检查参数和权限')
        return failure
