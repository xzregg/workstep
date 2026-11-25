"""Data-center Codex transports never host ordinary conversations."""
import asyncio

import pytest

from engines.codex_sdk_clients import CodexClientPool
from engines.core.session_retention import release_session_retention
from tests.test_session_retention import acquire

pytestmark = pytest.mark.asyncio


@pytest.mark.parametrize('main_first', [True, False])
async def test_dedicated_main_and_five_slot_shared_pool_are_separate(main_first):
    pool = CodexClientPool()
    try:
        if main_first:
            main = await acquire(pool, 'main', 'host-main')
            await pool.release(main, reusable=True)
        ordinary = [await acquire(pool, f'normal-{i}') for i in range(5)]
        if not main_first:
            main = await acquire(pool, 'main', 'host-main')
            await pool.release(main, reusable=True)
        assert len({id(e.client) for e in ordinary}) == 1
        assert all(e.client is not main.client for e in ordinary)
        sixth = await acquire(pool, 'sixth')
        assert sixth.client is not ordinary[0].client and sixth.client is not main.client
        assert main.worker.entries == {main}
        assert await acquire(pool, 'main', 'host-main') is main
    finally:
        await pool.close()


async def test_reset_reuses_private_worker_and_replaces_old_loaded_slot():
    pool = CodexClientPool()
    try:
        old = await acquire(pool, 'old-native', 'host-main')
        await pool.release(old, reusable=True)
        await release_session_retention('host-main')
        ordinary = await acquire(pool, 'ordinary')
        await pool.release(ordinary, reusable=True)
        new = await acquire(pool, 'new-native', 'host-main')
        assert new.client is old.client and new.client is not ordinary.client
        assert old.key not in pool._entries
        assert new.worker.entries == {new}
        assert not new.client.closed
    finally:
        await pool.close()


async def test_new_host_main_can_reuse_unprotected_private_worker_but_ordinary_cannot():
    pool = CodexClientPool()
    try:
        old = await acquire(pool, 'old', 'old-host-main')
        await pool.release(old, reusable=True)
        await release_session_retention('old-host-main')
        ordinary = await acquire(pool, 'ordinary')
        assert ordinary.client is not old.client
        new = await acquire(pool, 'new', 'new-host-main')
        assert new.client is old.client and old.key not in pool._entries
    finally:
        await pool.close()


async def test_shared_idle_budget_is_independent_of_private_main():
    pool = CodexClientPool()
    try:
        main = await acquire(pool, 'main', 'host-main')
        await pool.release(main, reusable=True)
        ordinary = await acquire(pool, 'ordinary')
        await pool.release(ordinary, reusable=True)
        assert not ordinary.client.closed and not main.client.closed
        assert await acquire(pool, 'ordinary') is ordinary
    finally:
        await pool.close()


async def test_dedicated_identity_upgrade_leaves_existing_shared_neighbor_alive():
    pool = CodexClientPool()
    try:
        old = await acquire(pool, 'main')
        neighbor = await acquire(pool, 'neighbor')
        await pool.release(old, reusable=True)
        main = await acquire(pool, 'main', 'host-main')
        assert main.client is not neighbor.client
        assert not neighbor.client.closed and neighbor.busy
        assert main.worker.entries == {main}
    finally:
        await pool.close()


async def test_retired_private_context_expires_without_retiring_shared_cache():
    pool = CodexClientPool(idle_seconds=.01)
    try:
        main = await acquire(pool, 'main', 'host-main')
        await pool.release(main, reusable=True)
        ordinary = await acquire(pool, 'ordinary')
        await pool.release(ordinary, reusable=True)
        await release_session_retention('host-main')
        await asyncio.sleep(.05)
        assert main.client.closed and not ordinary.client.closed
    finally:
        await pool.close()


async def test_same_main_owner_cannot_start_another_native_context_while_busy():
    pool = CodexClientPool()
    try:
        main = await acquire(pool, 'main', 'host-main')
        with pytest.raises(RuntimeError, match='session is executing'):
            await acquire(pool, 'another-native-id', 'host-main')
        assert len(pool._workers) == 1 and main.busy
        ordinary = await acquire(pool, 'ordinary')
        assert ordinary.client is not main.client
    finally:
        await pool.close()
