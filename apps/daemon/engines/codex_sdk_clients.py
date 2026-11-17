"""Event-loop-local Codex workers with five independently owned session slots."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import tomllib
import threading
import time
from typing import Any
from dataclasses import dataclass, field
from contextlib import suppress
import uuid

from engines.core.session_pool import SessionClientLease, SessionClientPool
from engines.codex_sdk_approvals import CodexApprovalRouter, deny_request
from engines.core.process_cleanup import finish_cleanup


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


deny_idle_request = deny_request


@dataclass(eq=False)
class CodexWorker:
    cwd: str
    fingerprint: str
    client: Any
    entries: set = field(default_factory=set)
    router: Any = None
    accepting: bool = True
    closing: Any = None
    failure_task: Any = None


@dataclass(eq=False)
class CodexClientLease(SessionClientLease):
    worker: Any = None
    handler: Any = None
    turn: Any = None
    starting_turn: bool = False


class CodexClientPool(SessionClientPool):
    def __init__(self, *, idle_seconds=600, max_idle=8, sessions_per_process=5):
        super().__init__(idle_seconds=idle_seconds, max_idle=max_idle)
        if sessions_per_process < 1:
            raise ValueError('sessions_per_process must be positive')
        self.sessions_per_process = sessions_per_process
        self._workers = []
        self._reservations = set()
        self._detaching = set()

    @staticmethod
    async def _alive(worker):
        sync = getattr(getattr(worker.client, '_client', None), '_sync', None)
        if not hasattr(sync, '_proc'):
            return True
        proc = sync._proc
        if proc is None:
            return not getattr(worker.client, '_initialized', False)
        return await asyncio.to_thread(proc.poll) is None

    async def acquire(self, cwd, session_id, fingerprint, factory):
        key = (cwd, session_id or uuid.uuid4().hex)
        if self._closed:
            raise RuntimeError('引擎客户端池已关闭')
        if key in self._reservations or key in self._detaching or (key in self._entries and self._entries[key].busy):
            raise RuntimeError('引擎会话正在执行，请等待当前回复完成')
        self._reservations.add(key)
        owned = None
        try:
            old = self._entries.get(key)
            if old is not None:
                old.busy = True
                owned = old
                if old.timer:
                    old.timer.cancel()
                    old.timer = None
                alive = await self._alive(old.worker)
                if self._closed or self._entries.get(key) is not old:
                    raise RuntimeError('引擎客户端已关闭')
                if alive and old.fingerprint == fingerprint and old.worker.accepting:
                    return old
                if not alive:
                    await self._retire_worker(old.worker)
                else:
                    await self.discard(old)
            worker = next((w for w in self._workers if w.accepting and w.cwd == cwd
                           and w.fingerprint == fingerprint
                           and sum(e.busy for e in w.entries) < self.sessions_per_process), None)
            if worker is None:
                worker = CodexWorker(cwd, fingerprint, factory())
                self._workers.append(worker)
            entry = CodexClientLease(key, fingerprint, worker.client, worker=worker)
            self._entries[key] = entry
            owned = entry
            worker.entries.add(entry)
            # Reserve the active slot before awaiting stale-session cleanup.
            idle = [e for e in self._entries.values() if e.worker is worker and not e.busy]
            for stale in idle[:max(0, len(worker.entries)-self.sessions_per_process)]:
                await self.discard(stale)
            if self._closed or self._entries.get(key) is not entry:
                raise RuntimeError('引擎客户端已关闭')
            return entry
        except BaseException:
            if owned is not None and self._entries.get(owned.key) is owned:
                await asyncio.shield(self.discard(owned))
            raise
        finally:
            self._reservations.discard(key)

    def set_handler(self, entry, handler):
        worker = entry.worker
        if worker.router is None:
            worker.router = CodexApprovalRouter(worker.client, lambda: self._transport_failed(worker))
        entry.handler = handler
        if entry.thread is not None:
            worker.router.bind(entry.thread.id, entry, handler)

    def bind(self, entry, session_id, thread):
        super().bind(entry, session_id, thread)
        if entry.worker.router is not None and entry.handler is not None:
            entry.worker.router.bind(session_id, entry, entry.handler)

    async def release(self, entry, *, reusable):
        if self._entries.get(entry.key) is not entry:
            cleanup = entry.closing or entry.worker.failure_task or entry.worker.closing
            if cleanup is not None:
                await asyncio.shield(cleanup)
            return
        if not reusable or not entry.worker.accepting:
            await self.discard(entry)
            return
        if entry.worker.router:
            entry.worker.router.unbind(entry)
        entry.handler = entry.on_close = None
        entry.turn = None
        entry.starting_turn = False
        # The base implementation retains per-session idle timers and LRU.
        await super().release(entry, reusable=True)

    def _schedule_worker_close(self, worker):
        if worker.closing is None:
            worker.accepting = False
            if worker.router:
                worker.router.close()
            if worker in self._workers:
                self._workers.remove(worker)
            worker.closing = asyncio.create_task(self._close_worker(worker))
            self._closing.add(worker.closing)
            worker.closing.add_done_callback(self._on_client_closed)
        return worker.closing

    async def _close_worker(self, worker):
        async def close_owned():
            if worker.router:
                await asyncio.to_thread(worker.router.wait_startup)
            sync = getattr(getattr(worker.client, '_client', None), '_sync', None)
            process = getattr(sync, '_proc', None)
            threads = {t for name in ('_reader_thread', '_stderr_thread')
                       if isinstance(t := getattr(sync, name, None), threading.Thread)}
            if worker.router:
                threads.update(worker.router.background_threads())
            def join_readers():
                deadline = time.monotonic() + 2
                for thread in threads:
                    if thread.is_alive():
                        thread.join(max(0, deadline-time.monotonic()))
                if any(t.is_alive() for t in threads):
                    raise RuntimeError('Codex SDK 后台读取线程未退出')
                for name in ('stdin', 'stdout', 'stderr'):
                    stream = getattr(process, name, None)
                    if stream is not None and not stream.closed:
                        with suppress(OSError):
                            stream.close()
            try:
                await self._close_client(worker.client)
            finally:
                # SDK close can raise before it joins its readers. Reap first,
                # then wait off-loop even on failure or repeated cancellation.
                await asyncio.to_thread(join_readers)
        await finish_cleanup(close_owned())

    async def _retire_worker(self, worker):
        for entry in list(worker.entries):
            self._forget(entry)
        await asyncio.shield(self._schedule_worker_close(worker))

    def _transport_failed(self, worker):
        if worker.closing is None and worker.failure_task is None:
            worker.accepting = False
            worker.failure_task = asyncio.create_task(self._retire_worker(worker))
            self._closing.add(worker.failure_task)
            worker.failure_task.add_done_callback(self._on_client_closed)

    def _forget(self, entry):
        if self._entries.get(entry.key) is entry:
            self._entries.pop(entry.key)
        if entry.timer:
            entry.timer.cancel()
            entry.timer = None
        if entry.on_close:
            entry.on_close()
            entry.on_close = None
        if entry.worker.router:
            entry.worker.router.unbind(entry)
        entry.worker.entries.discard(entry)
        entry.handler = None

    async def _detach(self, entry):
        worker = entry.worker
        # Cancel only this thread; never close the shared transport to stop it.
        try:
            if worker.entries and entry.thread is not None:
                async with asyncio.timeout(3):
                    if entry.turn is not None:
                        await entry.turn.interrupt()
                    raw = getattr(worker.client, '_client', None)
                    # Cancellation can race the turn/start RPC response. Recover
                    # its active ID instead of leaving that turn in the worker.
                    if entry.starting_turn and entry.turn is None:
                        current = await entry.thread.read(include_turns=True)
                        for turn in current.thread.turns:
                            if getattr(turn.status, 'value', turn.status) == 'inProgress':
                                await raw.turn_interrupt(entry.thread.id, turn.id)
                    if callable(getattr(raw, 'request', None)):
                        from openai_codex.generated.v2_all import ThreadUnsubscribeResponse
                        await raw.request('thread/unsubscribe', {'threadId': entry.thread.id},
                                          response_model=ThreadUnsubscribeResponse)
        except Exception:
            # A broken unsubscribe must not kill unrelated active threads.
            # Quarantine this worker; move sessions on their next acquisition.
            worker.accepting = False
        finally:
            if not worker.entries:
                await asyncio.shield(self._schedule_worker_close(worker))

    def _schedule_close(self, entry):
        if entry.closing is None:
            self._detaching.add(entry.key)
            self._forget(entry)
            entry.closing = asyncio.create_task(self._detach(entry))
            self._closing.add(entry.closing)
            entry.closing.add_done_callback(self._on_client_closed)
            entry.closing.add_done_callback(lambda _: self._detaching.discard(entry.key))
        return entry.closing

    async def close(self):
        self._closed = True
        workers = list(self._workers)
        for worker in workers:
            for entry in list(worker.entries):
                self._forget(entry)
        await asyncio.gather(*(asyncio.shield(self._schedule_worker_close(w)) for w in workers))
        if self._closing:
            await asyncio.gather(*list(self._closing))


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
