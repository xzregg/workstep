"""Host-owned retention is isolated from native thread IDs and pool capacity."""
import asyncio
from types import SimpleNamespace

import pytest

from engines.core.session_pool import SessionClientPool
from engines.codex_sdk_clients import CodexClientPool
from engines.core.session_retention import session_retention, release_session_retention

pytestmark = pytest.mark.asyncio


class Client:
    closed = False

    async def close(self):
        self.closed = True


async def acquire(pool, sid, owner=None, cwd='/p', fingerprint='same'):
    with session_retention(owner):
        entry = await pool.acquire(cwd, sid, fingerprint, Client)
    pool.bind(entry, sid, SimpleNamespace(id=sid))
    return entry


@pytest.mark.parametrize('pool_type', [SessionClientPool, CodexClientPool])
async def test_retained_session_survives_ttl_and_idle_lru_but_explicit_close_works(pool_type):
    pool = pool_type(idle_seconds=.01, max_idle=1)
    try:
        main = await acquire(pool, 'main', 'host-main')
        await pool.release(main, reusable=True)
        for i in range(4):
            other = await acquire(pool, str(i))
            await pool.release(other, reusable=True)
        await asyncio.sleep(.05)
        assert not main.client.closed
        assert await acquire(pool, 'main', 'host-main') is main
        await pool.release(main, reusable=True)
        await pool.close_session('main', '/p')
        assert main.client.closed
    finally:
        await pool.close()


async def test_codex_private_worker_preserves_shared_idle_budget_and_capacity():
    pool = CodexClientPool(idle_seconds=.01)
    try:
        main = await acquire(pool, 'main', 'host-main')
        await pool.release(main, reusable=True)
        other = await acquire(pool, 'other', cwd='/different')
        await pool.release(other, reusable=True)
        assert not other.client.closed and not main.client.closed
        # The private worker leaves all five shared slots available.
        others = [await acquire(pool, str(i)) for i in range(5)]
        assert len({id(e.client) for e in others}) == 1
        assert all(e.client is not main.client for e in others)
        assert await acquire(pool, 'main', 'host-main') is main
    finally:
        await pool.close()


@pytest.mark.parametrize('pool_type', [SessionClientPool, CodexClientPool])
async def test_new_native_id_and_engine_transfer_release_old_protection(pool_type):
    old_pool = pool_type(idle_seconds=.01)
    new_pool = SessionClientPool(idle_seconds=.01)
    try:
        old = await acquire(old_pool, 'old-id', 'host-main')
        await old_pool.release(old, reusable=True)
        new = await acquire(new_pool, 'new-id', 'host-main')
        await new_pool.release(new, reusable=True)
        assert old.retention_owner is None
        assert new.retention_owner == 'host-main'
        await release_session_retention('host-main')
        assert new.retention_owner is None
        await asyncio.sleep(.05)
        assert new.client.closed
    finally:
        await old_pool.close()
        await new_pool.close()


async def test_context_reset_unprotects_busy_session_without_stopping_other_turns():
    pool = CodexClientPool()
    try:
        main = await acquire(pool, 'main', 'host-main')
        neighbor = await acquire(pool, 'neighbor')
        await release_session_retention('host-main')
        assert main.retention_owner is None and main.busy
        assert not main.client.closed and not neighbor.client.closed
        await pool.release(main, reusable=False)
        assert not neighbor.client.closed
    finally:
        await pool.close()


async def test_failed_turn_and_configuration_change_are_not_protected_from_cleanup():
    pool = CodexClientPool()
    try:
        main = await acquire(pool, 'main', 'host-main')
        await pool.release(main, reusable=True)
        changed = await acquire(pool, 'main', 'host-main', fingerprint='different')
        assert main.client.closed and changed.client is not main.client
        await pool.release(changed, reusable=False)
        assert changed.client.closed
    finally:
        await pool.close()


async def test_one_shot_engine_accepts_host_policy_without_forwarding_or_retaining_old_transport():
    from agent_assistants.engine_invocation import run_engine_turn
    from engines.core.events import InternalEvent
    pool = SessionClientPool()
    try:
        old = await acquire(pool, 'old', 'host-main')
        await pool.release(old, reusable=True)

        class Engine:
            supports_process_reuse = False
            supports_resume = True
            supports_message_history = False
            capabilities = SimpleNamespace(supports_thinking_effort=False)

            async def spawn(self, **kwargs):
                assert 'session_retention_key' not in kwargs
                yield InternalEvent(type='agent_message_chunk', data={'content': {'text': 'OK'}})

        result = await run_engine_turn('one-shot', None, '/p', 'hello', None,
            engine_factory=lambda _: Engine(), settings_store=SimpleNamespace(),
            session_retention_key='host-main')
        assert result[0] == 'OK' and old.retention_owner is None
    finally:
        await pool.close()


async def test_invocation_context_does_not_leak_into_parallel_or_unmarked_turns():
    from agent_assistants.engine_invocation import run_engine_turn
    from engines.core.events import InternalEvent
    pool = SessionClientPool()

    class Engine:
        supports_process_reuse = True
        supports_resume = True
        supports_message_history = False
        capabilities = SimpleNamespace(supports_thinking_effort=False)

        async def spawn(self, prompt, **kwargs):
            entry = await pool.acquire('/p', prompt, 'same', Client)
            pool.bind(entry, prompt, SimpleNamespace(id=prompt))
            await asyncio.sleep(0)
            yield InternalEvent(type='agent_message_chunk', data={'content': {'text': entry.retention_owner or 'ordinary'}})
            await pool.release(entry, reusable=True)

    async def invoke(prompt, owner=None):
        return await run_engine_turn('reusable', None, '/p', prompt, None,
            engine_factory=lambda _: Engine(), settings_store=SimpleNamespace(), session_retention_key=owner)
    try:
        with session_retention('ambient-must-not-leak'):
            a, b, ordinary = await asyncio.gather(invoke('a', 'main-a'), invoke('b', 'main-b'), invoke('ordinary'))
        assert [a[0], b[0], ordinary[0]] == ['main-a', 'main-b', 'ordinary']
        assert pool._entries[('/p', 'ordinary')].retention_owner is None
    finally:
        await pool.close()
