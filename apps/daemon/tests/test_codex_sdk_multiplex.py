"""Shared Codex workers retain per-thread ownership and bounded capacity."""
import asyncio
from types import SimpleNamespace

import pytest

from engines.codex_sdk_clients import CodexClientPool


class Client:
    def __init__(self):
        self.closed = 0

    async def close(self):
        self.closed += 1


@pytest.mark.anyio
async def test_five_active_sessions_per_worker_and_sixth_overflows():
    pool = CodexClientPool()
    try:
        entries = [await pool.acquire('/p', str(i), 'same', Client) for i in range(11)]
        for e in entries:
            pool.bind(e, e.key[1], SimpleNamespace(id=e.key[1]))
        assert len({id(e.client) for e in entries[:5]}) == 1
        assert len({id(e.client) for e in entries[5:10]}) == 1
        assert len({id(e.client) for e in entries}) == 3
        await pool.release(entries[0], reusable=True)
        assert await pool.acquire('/p', '0', 'same', Client) is entries[0]
        with pytest.raises(RuntimeError, match='正在执行'):
            await pool.acquire('/p', '0', 'same', Client)
        await pool.discard(entries[0])
        assert entries[1].client.closed == 0
        new = await pool.acquire('/p', 'new', 'same', Client)
        assert new.client is entries[1].client
    finally:
        await pool.close()
    assert all(e.client.closed == 1 for e in entries)


@pytest.mark.anyio
async def test_idle_slots_are_reassigned_without_starting_another_worker():
    pool = CodexClientPool()
    try:
        entries = [await pool.acquire('/p', str(i), 'same', Client) for i in range(5)]
        for e in entries:
            pool.bind(e, e.key[1], SimpleNamespace(id=e.key[1]))
            await pool.release(e, reusable=True)
        extra = await pool.acquire('/p', 'sixth', 'same', Client)
        assert extra.client is entries[0].client
        assert len(pool._entries) <= 5
        assert extra.client.closed == 0
    finally:
        await pool.close()


@pytest.mark.anyio
async def test_closing_or_expiring_one_session_preserves_active_neighbor():
    pool = CodexClientPool(idle_seconds=.01)
    try:
        a = await pool.acquire('/p', 'a', 'same', Client)
        b = await pool.acquire('/p', 'b', 'same', Client)
        assert a.client is b.client
        for e in [a,b]:
            pool.bind(e, e.key[1], SimpleNamespace(id=e.key[1]))
        await pool.release(a, reusable=True)
        await asyncio.sleep(.05)
        assert ('/p','a') not in pool._entries
        assert b.client.closed == 0 and b.busy
        await pool.close_session('b', '/p')
        assert b.client.closed == 1
    finally:
        await pool.close()


@pytest.mark.anyio
async def test_different_runtime_identity_cannot_share_and_change_preserves_neighbor():
    pool = CodexClientPool()
    try:
        a = await pool.acquire('/p', 'a', 'same', Client)
        b = await pool.acquire('/p', 'b', 'same', Client)
        other = await pool.acquire('/other', 'c', 'same', Client)
        for e in [a,b,other]:
            pool.bind(e, e.key[1], SimpleNamespace(id=e.key[1]))
        await pool.release(a, reusable=True)
        changed = await pool.acquire('/p', 'a', 'different', Client)
        assert changed.client is not b.client and other.client is not b.client
        assert b.client.closed == 0
    finally:
        await pool.close()


@pytest.mark.anyio
async def test_cancel_acquisition_during_idle_unload_releases_slot_and_preserves_neighbor():
    pool = CodexClientPool(sessions_per_process=2)
    entered, unblock = asyncio.Event(), asyncio.Event()
    async def request(*args, **kwargs):
        entered.set()
        await unblock.wait()
    try:
        a = await pool.acquire('/p', 'a', 'same', Client)
        b = await pool.acquire('/p', 'b', 'same', Client)
        a.client._client = SimpleNamespace(request=request)
        for entry in [a,b]:
            pool.bind(entry, entry.key[1], SimpleNamespace(id=entry.key[1]))
            await pool.release(entry, reusable=True)
        acquiring = asyncio.create_task(pool.acquire('/p', 'c', 'same', Client))
        await asyncio.wait_for(entered.wait(), 1)
        # Unloading A cannot allow a second loader for the same native ID.
        with pytest.raises(RuntimeError, match='正在执行'):
            await pool.acquire('/p', 'a', 'same', Client)
        assert await pool.acquire('/p', 'b', 'same', Client) is b
        await asyncio.wait_for(asyncio.sleep(.01), .05)
        acquiring.cancel()
        with pytest.raises(asyncio.CancelledError):
            await acquiring
        assert ('/p', 'c') not in pool._entries
        assert b.busy and b.client.closed == 0
        unblock.set()
    finally:
        unblock.set()
        await pool.close()
