import asyncio

import pytest

from engines.opencode import OpencodeEngine


@pytest.mark.asyncio
async def test_default_quota_is_unsupported_without_starting_engine():
    from engines.core.quota import query_quota
    engine = OpencodeEngine()
    assert not engine.supports_quota
    assert await engine.get_quota() is None
    result = await query_quota(engine, '')
    assert result['status'] == 'unsupported'
    assert result['supported'] is False


@pytest.mark.asyncio
async def test_query_normalizes_groups_and_preserves_fractional_percentages():
    from engines.core.quota import query_quota
    class Engine:
        ENGINE_ID = 'example'
        supports_quota = True
        async def get_quota(self, cwd=''):
            assert cwd == '/project'
            return {'groups': [{'name': 'Model', 'windows': [
                {'kind': 'weekly', 'remaining_percent': 81.5, 'resets_at': 1800000000},
                {'kind': 'five-hour', 'used_percent': 40.2},
            ]}], 'secret': 'must not be projected'}
    result = await query_quota(Engine(), '/project')
    assert result['status'] == 'ok'
    assert result['quota']['engine_id'] == 'example'
    assert result['quota']['primary']['remaining_percent'] == 59.8
    assert result['quota']['groups'][0]['windows'][0]['used_percent'] == 18.5
    assert result['quota']['collected_at'] > 0
    assert 'secret' not in result['quota']


@pytest.mark.asyncio
@pytest.mark.parametrize('value', [None, {}, {'primary': {'remaining_percent': float('nan')}},
                                 {'primary': {'remaining_percent': 101}}])
async def test_missing_or_invalid_data_is_unavailable_not_unsupported(value):
    from engines.core.quota import query_quota
    class Engine:
        ENGINE_ID = 'example'
        supports_quota = True
        async def get_quota(self, cwd=''):
            return value
    result = await query_quota(Engine(), '')
    assert result == {'engine_id': 'example', 'supported': True, 'status': 'unavailable', 'quota': None}


@pytest.mark.asyncio
async def test_timeout_cancellation_and_event_loop_responsiveness():
    from engines.core.quota import query_quota
    finished = asyncio.Event()
    class Engine:
        ENGINE_ID = 'example'
        supports_quota = True
        async def get_quota(self, cwd=''):
            try:
                await asyncio.sleep(60)
            finally:
                finished.set()
    task = asyncio.create_task(query_quota(Engine(), '', timeout=.05))
    await asyncio.sleep(.01)
    assert not task.done()
    assert (await task)['status'] == 'unavailable'
    assert finished.is_set()
    task = asyncio.create_task(query_quota(Engine(), ''))
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_authentication_failure_is_distinct_and_redacted():
    from engines.core.quota import QuotaAuthenticationRequired, query_quota
    class Engine:
        ENGINE_ID = 'example'
        supports_quota = True
        async def get_quota(self, cwd=''):
            raise QuotaAuthenticationRequired('secret token')
    result = await query_quota(Engine(), '')
    assert result['status'] == 'unauthenticated'
    assert 'secret' not in str(result)


def test_codex_adapter_preserves_native_fractional_usage_and_missing_windows():
    from engines.codex_sdk import CodexSDKEngine
    from types import SimpleNamespace
    window = CodexSDKEngine._quota_window(SimpleNamespace(used_percent=18.5))
    assert window['used_percent'] == 18.5
    assert window['remaining_percent'] == 81.5
    assert CodexSDKEngine._quota_window(SimpleNamespace()) is None
