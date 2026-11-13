"""Exclusive, event-loop-local leases for persistent Codex app-server clients.

One native session owns one process. Only idle clients are cached; callers
must discard leases after cancellation, an incomplete stream or an error.
"""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import tomllib
from typing import Any


def client_fingerprint(client_config: Any, thread_kwargs: dict) -> str:
    """Run in a worker: include credentials/config identity without logging them."""
    env = client_config.env if client_config.env is not None else os.environ
    codex_home = Path(env.get('CODEX_HOME') or Path.home() / '.codex')
    files = [codex_home / 'config.toml', codex_home / 'auth.json']
    configured_file = (thread_kwargs.get('config') or {}).get('model_instructions_file')
    if configured_file:
        try:
            configured_file = tomllib.loads(f'value = {configured_file}')['value']
        except tomllib.TOMLDecodeError:
            pass
        path = Path(str(configured_file)).expanduser()
        files.append(path if path.is_absolute() else Path(client_config.cwd or '.') / path)
    if client_config.codex_bin:
        files.append(Path(client_config.codex_bin))
    stamps = []
    for path in files:
        try:
            stat = path.stat()
            stamps.append((str(path), stat.st_mtime_ns, stat.st_size))
        except FileNotFoundError:
            stamps.append((str(path), None, None))
    # Initial rules belong to the thread, not the process. Resume normally
    # omits them, while explicit rule updates use thread/inject_items.
    settings = {k: v for k, v in thread_kwargs.items() if k != 'developer_instructions'}
    settings['config'] = {k: v for k, v in (settings.get('config') or {}).items()
                          if k != 'developer_instructions'}
    payload = (client_config.codex_bin, client_config.cwd, client_config.config_overrides,
               client_config.env, settings, stamps)
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


def deny_idle_request(method: str, params: Any) -> dict:
    if method == 'item/tool/requestUserInput':
        return {'answers': {}}
    if method == 'mcpServer/elicitation/request':
        return {'action': 'cancel', 'content': None, '_meta': None}
    return {'decision': 'deny'}


from engines.core.session_pool import (
    SessionClientLease as CodexClientLease,
    SessionClientPool as CodexClientPool,
)


def get_codex_client_pool() -> CodexClientPool:
    loop = asyncio.get_running_loop()
    pool = getattr(loop, '_workstep_codex_client_pool', None)
    if pool is None or pool._closed:
        pool = CodexClientPool()
        loop._workstep_codex_client_pool = pool
    return pool


async def close_codex_clients() -> None:
    pool = getattr(asyncio.get_running_loop(), '_workstep_codex_client_pool', None)
    if pool is not None:
        await pool.close()
