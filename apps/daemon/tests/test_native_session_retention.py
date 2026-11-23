"""Each reusable adapter must keep its real transport under host retention."""
import asyncio

import pytest

from engines.core.session_pool import get_session_pool
from engines.core.session_retention import session_retention, release_session_retention
from tests import test_sdk_session_reuse as sdk
from tests import test_acp_session_reuse as acp
from tests import test_cursor_session_reuse as cursor_adapter
from tests import test_claude_cli_session_reuse as cli_adapter
from tests import test_custom_engine_reuse as custom
from tests.test_sdk_session_reuse import sdk_engine
from tests.test_acp_session_reuse import engine_config
from tests.test_cursor_session_reuse import cursor
from tests.test_claude_cli_session_reuse import cli
from tests.test_custom_engines import custom_environment


async def check(pool, root, run, get_sid, get_process):
    pool.idle_seconds = .01
    pool.max_idle = 0
    with session_retention('main'):
        sid = get_sid(await run('hello', None))
    entry = pool._entries[(str(root), sid)]
    process = get_process(entry)
    await asyncio.sleep(.05)
    assert process.returncode is None
    with session_retention('main'):
        assert get_sid(await run('again', sid)) == sid
    assert pool._entries[(str(root), sid)] is entry
    await release_session_retention('main')
    pool._expire(entry)
    await asyncio.wait_for(asyncio.shield(entry.closing), 5)
    assert process.returncode is not None


@pytest.mark.anyio
async def test_python_sdk_retention(sdk_engine):
    cls, root = sdk_engine
    await check(get_session_pool(cls.ENGINE_ID), root,
                lambda prompt, sid: sdk.collect(sdk_engine, prompt, sid), sdk.session,
                lambda entry: entry.client.value.process)


@pytest.mark.anyio
async def test_acp_retention(engine_config):
    cls, root = engine_config
    await check(get_session_pool(cls.ENGINE_ID), root,
                lambda prompt, sid: acp.collect(engine_config, prompt, sid), acp.sid,
                lambda entry: entry.client.value.process)


@pytest.mark.anyio
async def test_cursor_retention(cursor):
    await check(get_session_pool('cursor'), cursor,
                lambda prompt, sid: cursor_adapter.collect(cursor, prompt, sid), cursor_adapter.session,
                lambda entry: entry.client.value.process)


@pytest.mark.anyio
async def test_cli_retention(cli):
    await check(get_session_pool('claude'), cli,
                lambda prompt, sid: cli_adapter.collect(cli, prompt, sid), cli_adapter.sid,
                lambda entry: entry.client.value.process)


@pytest.mark.anyio
async def test_custom_worker_retention(custom_environment):
    cls = await custom.configured(custom_environment)
    try:
        await check(get_session_pool('custom:example_custom'), custom_environment,
                    lambda prompt, sid: custom.run(cls, custom_environment, prompt, sid), custom.sid,
                    lambda entry: entry.client.process)
    finally:
        await custom.close_session_pools()
