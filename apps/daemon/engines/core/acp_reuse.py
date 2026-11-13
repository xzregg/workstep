"""Retain one ACP connection per native session, with fresh turn routing."""
import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace

import acp

from engines.core.process_cleanup import terminate_owned_process, _snapshot
from engines.core.session_pool import ManagedConnection, get_session_pool, startup_fingerprint


class SessionAgent:
    def __init__(self, value, pool, lease):
        self.value, self.pool, self.lease = value, pool, lease
        self.success = False
        self.tasks = set()

    def __getattr__(self, name):
        return getattr(self.value.client, name)

    async def initialize(self, **kwargs):
        if not self.value.initialized:
            self.value.response = await self.value.client.initialize(**kwargs)
            self.value.initialized = True
        return self.value.response

    async def new_session(self, **kwargs):
        session = await self.value.client.new_session(**kwargs)
        self.pool.bind(self.lease, session.session_id, session.session_id)
        return session

    async def _restore(self, name, **kwargs):
        if self.lease.thread != kwargs['session_id']:
            response = await getattr(self.value.client, name)(**kwargs)
            self.pool.bind(self.lease, kwargs['session_id'], kwargs['session_id'])
            return response
        return SimpleNamespace()

    async def load_session(self, **kwargs):
        return await self._restore('load_session', **kwargs)

    async def resume_session(self, **kwargs):
        return await self._restore('resume_session', **kwargs)

    async def prompt(self, **kwargs):
        self.tasks.add(asyncio.current_task())
        self.success = False
        response = await self.value.client.prompt(**kwargs)
        self.success = str(getattr(response, 'stop_reason', 'end_turn')) == 'end_turn'
        return response


def cancel_handler(handler):
    for name in ('_approval_futures', '_elicitation_futures'):
        for future in getattr(handler, name, {}).values():
            if not future.done():
                future.cancel()


@asynccontextmanager
async def pooled_acp_process(engine, handler, cmd, *, cwd, env, session_id, settings):
    pool = get_session_pool(engine.ENGINE_ID)
    fingerprint = await asyncio.to_thread(startup_fingerprint, (cwd, cmd, env, settings))
    @asynccontextmanager
    async def context():
        process = None
        snapshot = None
        try:
            async with acp.spawn_agent_process(handler, cmd[0], *cmd[1:], cwd=cwd, env=env) as (client, process):
                try:
                    yield SimpleNamespace(client=client, process=process, handler=handler,
                                          initialized=False, response=None)
                finally:
                    cancel_handler(handler)
                    snapshot = await asyncio.to_thread(_snapshot, process)
        finally:
            if process is not None:
                await terminate_owned_process(process, snapshot=snapshot)
    lease = await pool.acquire(cwd, session_id, fingerprint, lambda: ManagedConnection(context))
    engine._transport_lease = lease
    complete = False
    agent = None
    try:
        value = await lease.client.open()
        handler = value.handler
        handler.permission_mode = engine.runtime_permission_mode() or engine.get_permission_mode()
        handler.updates = asyncio.Queue()
        engine._handler = handler
        lease.on_close = lambda: cancel_handler(handler)
        agent = SessionAgent(value, pool, lease)
        yield agent, value.process
        complete = agent.success and engine.supports_process_reuse
    finally:
        if agent is not None:
            handler.permission_mode = 'deny'
            cancel_handler(handler)
            for task in agent.tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*agent.tasks, return_exceptions=True)
        if getattr(engine, '_transport_lease', None) is lease:
            engine._transport_lease = None
        await pool.release(lease, reusable=complete)
