"""Exclusive event-loop-local session transports with bounded idle retention."""
import asyncio
from dataclasses import dataclass
from typing import Any, Callable
import uuid
from contextlib import aclosing
from functools import wraps

from engines.core.process_cleanup import close_sdk_client, finish_cleanup


def exclusive_engine_run(function):
    """A mutable engine object belongs to one invocation until its stream closes."""
    @wraps(function)
    async def run(self, *args, **kwargs):
        if getattr(self, '_engine_run_active', False):
            raise RuntimeError('同一引擎实例正在执行，请等待当前回复完成')
        self._engine_run_active = True
        try:
            async with aclosing(function(self, *args, **kwargs)) as stream:
                async for event in stream:
                    yield event
        finally:
            self._engine_run_active = False
            self._running = False
    return run

@dataclass(eq=False)
class SessionClientLease:
    key: tuple[str, str]
    fingerprint: str
    client: Any
    thread: Any = None
    busy: bool = True
    timer: asyncio.TimerHandle | None = None
    closing: asyncio.Task | None = None
    on_close: Callable[[], None] | None = None


class SessionClientPool:
    def __init__(self, *, idle_seconds: float = 600, max_idle: int = 8):
        self.idle_seconds = idle_seconds
        self.max_idle = max_idle
        self._entries: dict[tuple[str, str], SessionClientLease] = {}
        self._closing: set[asyncio.Task] = set()
        self._closed = False

    async def acquire(self, cwd: str, session_id: str | None, fingerprint: str,
                      factory: Callable[[], Any]) -> SessionClientLease:
        if self._closed:
            raise RuntimeError('引擎客户端池已关闭')
        key = (cwd, session_id or uuid.uuid4().hex)
        entry = self._entries.get(key)
        if entry is not None:
            if entry.busy:
                raise RuntimeError('引擎会话正在执行，请等待当前回复完成')
            entry.busy = True
            if entry.timer:
                entry.timer.cancel()
                entry.timer = None
            try:
                check = getattr(entry.client, 'is_alive', None)
                if check is not None:
                    alive = check()
                else:
                    sync = getattr(getattr(entry.client, '_client', None), '_sync', None)
                    proc = getattr(sync, '_proc', None)
                    alive = not hasattr(sync, '_proc') or (
                        proc is not None and await asyncio.to_thread(proc.poll) is None
                    )
                if self._closed or self._entries.get(key) is not entry:
                    raise RuntimeError('引擎客户端已关闭')
                if entry.fingerprint == fingerprint and alive:
                    return entry
            except BaseException:
                await self.discard(entry)
                raise
            # Retain the reservation while closing; another caller must not
            # acquire this same session with a different configuration.
            try:
                await self._close_entry(entry)
                replacement = SessionClientLease(key, fingerprint, factory())
                if self._closed:
                    await self._close_entry(replacement)
                    raise RuntimeError('引擎客户端池已关闭')
                self._entries[key] = replacement
                return replacement
            except BaseException:
                if self._entries.get(key) is entry:
                    self._entries.pop(key)
                raise
        entry = SessionClientLease(key, fingerprint, factory())
        self._entries[key] = entry
        return entry

    def bind(self, entry: SessionClientLease, session_id: str, thread: Any) -> None:
        key = (entry.key[0], session_id)
        if self._entries.get(entry.key) is not entry or self._closed:
            raise RuntimeError('引擎客户端已关闭')
        if key != entry.key:
            if key in self._entries:
                raise RuntimeError('引擎会话已被其他执行占用')
            self._entries.pop(entry.key)
            entry.key = key
            self._entries[key] = entry
        entry.thread = thread

    async def release(self, entry: SessionClientLease, *, reusable: bool) -> None:
        if self._entries.get(entry.key) is not entry:
            return
        if not reusable or self._closed or entry.thread is None:
            await self.discard(entry)
            return
        entry.busy = False
        # Dict insertion order is idle LRU order.
        self._entries.pop(entry.key)
        self._entries[entry.key] = entry
        entry.timer = asyncio.get_running_loop().call_later(self.idle_seconds, self._expire, entry)
        idle = [e for e in self._entries.values() if not e.busy]
        for stale in idle[:max(0, len(idle) - self.max_idle)]:
            if not stale.busy and self._entries.get(stale.key) is stale:
                await self.discard(stale)

    def _expire(self, entry: SessionClientLease) -> None:
        if self._entries.get(entry.key) is entry and not entry.busy:
            self._entries.pop(entry.key)
            self._schedule_close(entry)

    def _schedule_close(self, entry: SessionClientLease) -> asyncio.Task:
        if entry.timer:
            entry.timer.cancel()
            entry.timer = None
        if entry.closing is None:
            if entry.on_close is not None:
                entry.on_close()
                entry.on_close = None
            entry.closing = asyncio.create_task(self._close_client(entry.client))
            self._closing.add(entry.closing)
            entry.closing.add_done_callback(self._on_client_closed)
        return entry.closing

    def _on_client_closed(self, task: asyncio.Task) -> None:
        self._closing.discard(task)
        if not task.cancelled() and task.exception() is not None:
            import logging
            logging.getLogger(__name__).error(
                'Engine process reclamation failed (%s)', type(task.exception()).__name__,
            )

    @staticmethod
    async def _close_client(client: Any) -> None:
        await finish_cleanup(close_sdk_client(client, 'close'))

    async def _close_entry(self, entry: SessionClientLease) -> None:
        await asyncio.shield(self._schedule_close(entry))

    async def discard(self, entry: SessionClientLease) -> None:
        entry.busy = True
        await self._close_entry(entry)
        if self._entries.get(entry.key) is entry:
            self._entries.pop(entry.key)

    async def close_session(self, session_id: str, cwd: str | None = None) -> None:
        entries = [e for e in self._entries.values()
                   if e.key[1] == session_id and (cwd is None or e.key[0] == cwd)]
        await asyncio.gather(*(self.discard(e) for e in entries))

    async def close(self) -> None:
        self._closed = True
        entries = list(self._entries.values())
        self._entries.clear()
        await asyncio.gather(*(self._close_entry(e) for e in entries))
        if self._closing:
            await asyncio.gather(*list(self._closing))


class ManagedConnection:
    """Enter and exit native context managers in one persistent owner task.

    SDK/ACP implementations may keep anyio cancel scopes open across turns.
    Merely caching their client in a different request task is insufficient.
    """
    def __init__(self, context):
        self.context = context
        self.value = None
        self._owner = None
        self._ready = None
        self._close = asyncio.Event()
        self._closed = False

    async def _run(self):
        try:
            async with self.context() as value:
                self.value = value
                self._ready.set_result(value)
                await self._close.wait()
        except BaseException as exc:
            if not self._ready.done():
                self._ready.set_exception(exc)
            else:
                raise
        finally:
            self._closed = True

    async def open(self):
        if self._closed:
            raise RuntimeError('引擎连接已关闭')
        if self._owner is None:
            self._ready = asyncio.get_running_loop().create_future()
            self._ready.add_done_callback(lambda future: future.exception() if not future.cancelled() else None)
            self._owner = asyncio.create_task(self._run())
            self._owner.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
        return await asyncio.shield(self._ready)

    def is_alive(self):
        process = getattr(self.value, 'process', None)
        return not self._closed and (self._owner is None or not self._owner.done()) and (
            process is None or getattr(process, 'returncode', None) is None
        )

    async def close(self):
        self._close.set()
        if self._owner is not None:
            if not self._ready.done():
                self._owner.cancel()
            try:
                async with asyncio.timeout(4):
                    await asyncio.shield(self._owner)
            except TimeoutError:
                self._owner.cancel()
                await asyncio.gather(self._owner, return_exceptions=True)
        else:
            self._closed = True


def get_session_pool(engine_id: str) -> SessionClientPool:
    loop = asyncio.get_running_loop()
    pools = getattr(loop, '_workstep_session_pools', None)
    if pools is None:
        pools = {}
        loop._workstep_session_pools = pools
    pool = pools.get(engine_id)
    if pool is None or pool._closed:
        pool = pools[engine_id] = SessionClientPool()
    return pool


async def close_session_pools():
    pools = getattr(asyncio.get_running_loop(), '_workstep_session_pools', {})
    await asyncio.gather(*(pool.close() for pool in list(pools.values())))


def startup_fingerprint(value) -> str:
    """Hash startup identity off the event loop, never print secret values."""
    from dataclasses import asdict, is_dataclass
    import hashlib
    import json
    import os
    from pathlib import Path
    from services.conversation_context import execution_env
    from services.coordinator_source import coordinator_source_env
    paths = {Path.home() / name for name in (
        '.claude/settings.json', '.claude/.credentials.json',
        '.qoder/settings.json', '.qoder/credentials.json',
    )}
    def plain(item):
        if is_dataclass(item):
            return plain(asdict(item))
        if isinstance(item, dict):
            return {str(k): plain(v) for k, v in item.items()}
        if isinstance(item, (list, tuple)):
            return [plain(v) for v in item]
        if callable(item):
            return '<callback>'
        if (isinstance(item, (str, Path)) and str(item).startswith('/')
                and len(str(item)) < 1024 and os.pathsep not in str(item) and '\n' not in str(item)):
            path = Path(item)
            try:
                directory = path.is_dir()
            except OSError:
                directory = False
            if directory:
                paths.update(path / name for name in (
                    '.claude/settings.json', '.claude/settings.local.json', '.mcp.json',
                    '.qoder/settings.json', 'opencode.json', 'opencode.jsonc',
                ))
            else:
                paths.add(path)
        return item
    settings = plain(value)
    stamps = []
    for path in sorted(paths):
        try:
            stat = path.stat()
            if path.suffix.lower() in {'.json', '.jsonc', '.toml', '.yaml', '.yml', '.md', '.txt'} and stat.st_size <= 1024 * 1024:
                stamps.append((str(path), hashlib.sha256(path.read_bytes()).hexdigest()))
            else:
                stamps.append((str(path), stat.st_mtime_ns, stat.st_size))
        except OSError:
            stamps.append((str(path), None, None))
    env = execution_env(dict(os.environ))
    env.update(coordinator_source_env())
    # Claude rewrites usage counters in this file after every reply. Only
    # execution/auth/MCP settings affect the transport, not those counters.
    claude_config = Path.home() / '.claude.json'
    try:
        config = json.loads(claude_config.read_text())
        if not isinstance(config, dict) or not isinstance(config.get('projects', {}), dict):
            raise ValueError('Invalid native settings')
        relevant = {key: config[key] for key in (
            'mcpServers', 'oauthAccount', 'primaryApiKey', 'apiKeyHelper', 'env', 'permissions',
        ) if key in config}
        relevant['projects'] = {
            key: {name: value[name] for name in (
                'allowedTools', 'mcpServers', 'disabledMcpServers',
                'disabledMcpjsonServers', 'enabledMcpjsonServers', 'hasTrustDialogAccepted',
            ) if name in value}
            for key, value in config.get('projects', {}).items() if isinstance(value, dict)
        }
    except (OSError, ValueError):
        relevant = None
    return hashlib.sha256(json.dumps((settings, env, stamps, relevant), sort_keys=True,
                                     default=str).encode()).hexdigest()

