import asyncio
import json

import pytest

from .test_custom_engines import custom_environment
from engines.core.custom_proxy import make_custom_engine
from engines.core.session_pool import get_session_pool, close_session_pools


REUSABLE = '''import asyncio, uuid
from engines.core.custom_sdk import CustomEngineBase
from engines.core.events import InternalEvent, agent_message_chunk
class ExampleEngine(CustomEngineBase):
    ENGINE_ID = 'example_custom'
    acp_events = frozenset({'agent_message_chunk', 'session_started', 'status', 'error'})
    supports_process_reuse = True
    supports_resume = True
    @staticmethod
    def is_installed(): return True
    @staticmethod
    def get_version(): return '1.0'
    @staticmethod
    def resolve_binary(): return None
    def __init__(self):
        super().__init__()
        self.count = 0
    async def resume_session(self, session_id, cwd, **kwargs): return bool(session_id)
    async def spawn(self, prompt, cwd, session_id=None, **kwargs):
        sid = session_id or str(uuid.uuid4())
        self.count += 1
        yield InternalEvent('session_started', {'session_id': sid})
        if prompt == 'wait':
            await asyncio.Event().wait()
        yield agent_message_chunk(str(self.count))
        yield InternalEvent('status', {'status':'done'})
    async def stop(self): pass
'''


async def configured(source):
    from services.custom_engines import custom_engine_manager
    (source / 'engine.py').write_text(REUSABLE)
    metadata = (await custom_engine_manager.inspect(str(source)))['engine']
    return make_custom_engine(source, metadata)


async def run(cls, source, prompt='hello', sid=None):
    return [e async for e in cls().spawn(prompt, str(source), session_id=sid)]


def sid(events):
    return next(e.data['session_id'] for e in events if e.type == 'session_started')


@pytest.mark.anyio
async def test_custom_worker_reuses_across_proxy_instances_and_isolates_sessions(custom_environment):
    source = custom_environment
    cls = await configured(source)
    pool = get_session_pool('custom:example_custom')
    try:
        first = await run(cls, source)
        session = sid(first)
        entry = pool._entries[(str(source), session)]
        process = entry.client.process
        second = await run(cls, source, sid=session)
        assert pool._entries[(str(source), session)] is entry
        assert [e.data['content']['text'] for e in second if e.type == 'agent_message_chunk'] == ['2']
        independent = await run(cls, source)
        other = pool._entries[(str(source), sid(independent))]
        assert other.client.process.pid != process.pid
        await cls().cancel_session(session, str(source))
        assert process.returncode is not None and other.client.process.returncode is None
    finally:
        await close_session_pools()


@pytest.mark.anyio
async def test_custom_worker_ttl_and_config_change_rebuild(custom_environment):
    from services.config import config_store
    source = custom_environment
    cls = await configured(source)
    pool = get_session_pool('custom:example_custom')
    try:
        first = await run(cls, source)
        session = sid(first)
        old = pool._entries[(str(source), session)]
        config_store._cache['reuse_test'] = 'changed'
        second = await run(cls, source, sid=session)
        assert sid(second) == session and old.client.process.returncode is not None
        pool.idle_seconds = 0.01
        await run(cls, source, sid=session)
        current = pool._entries[(str(source), session)]
        await asyncio.sleep(0.08)
        if current.closing is not None:
            await asyncio.wait_for(asyncio.shield(current.closing), 5)
        assert current.client.process.returncode is not None
    finally:
        await close_session_pools()


@pytest.mark.anyio
async def test_custom_worker_same_session_busy_and_stop(custom_environment):
    source = custom_environment
    cls = await configured(source)
    pool = get_session_pool('custom:example_custom')
    engine = cls()
    stream = engine.spawn('wait', str(source))
    try:
        event = await anext(stream)
        session = event.data['session_id']
        entry = pool._entries[(str(source), session)]
        with pytest.raises(RuntimeError, match='session is executing'):
            await run(cls, source, sid=session)
        assert entry.client.process.returncode is None
        await asyncio.wait_for(engine.stop(), 3)
        await stream.aclose()
        assert entry.client.process.returncode is not None
    finally:
        await stream.aclose()
        await close_session_pools()


@pytest.mark.anyio
async def test_reuse_declaration_requires_resume_and_validation_exercises_host_pool(custom_environment):
    from services.custom_engines import custom_engine_manager
    source = custom_environment
    (source / 'engine.py').write_text(REUSABLE.replace('supports_resume = True', 'supports_resume = False'))
    with pytest.raises(Exception):
        await custom_engine_manager.inspect(str(source))
    (source / 'engine.py').write_text(REUSABLE)
    result = await custom_engine_manager.run_operation('validate', str(source))
    check = next(c for c in result['checks'] if c['name'] == 'session_transport_reuse')
    assert check['status'] == 'passed', result


@pytest.mark.anyio
async def test_custom_cached_workers_release_for_maintenance_but_active_workers_stay(custom_environment):
    from services.custom_engines import custom_engine_manager
    source = custom_environment
    cls = await configured(source)
    pool = get_session_pool('custom:example_custom')
    try:
        first = await run(cls, source)
        entry = pool._entries[(str(source), sid(first))]
        process = entry.client.process
        await custom_engine_manager._close_cached_workers(source)
        assert not pool._entries and process.returncode is not None
        engine = cls()
        stream = engine.spawn('wait', str(source))
        try:
            event = await anext(stream)
            current = pool._entries[(str(source), event.data['session_id'])]
            await custom_engine_manager._close_cached_workers(source)
            assert current.client.process.returncode is None
            await custom_engine_manager._close_cached_workers(source, include_busy=True)
            assert current.client.process.returncode is not None
        finally:
            await stream.aclose()
    finally:
        await close_session_pools()


@pytest.mark.anyio
async def test_custom_reuse_preserves_prepared_controls_and_closes_unused_worker(custom_environment):
    source = custom_environment
    cls = await configured(source)
    pool = get_session_pool('custom:example_custom')
    try:
        one = cls()
        await one.set_permission_mode('ask')
        first = [e async for e in one.spawn('hello', str(source))]
        session = sid(first)
        entry = pool._entries[(str(source), session)]
        two = cls()
        await two.set_permission_mode('ask')
        prepared = two._worker
        assert prepared.process.returncode is None
        await anext_until_finished(two, source, session)
        assert pool._entries[(str(source), session)] is entry
        assert prepared.process.returncode is not None
        three = cls()
        await three.set_permission_mode('auto')
        await anext_until_finished(three, source, session)
        assert pool._entries[(str(source), session)] is not entry
        assert entry.client.process.returncode is not None
    finally:
        await close_session_pools()


async def anext_until_finished(engine, source, session):
    return [e async for e in engine.spawn('hello', str(source), session_id=session)]
