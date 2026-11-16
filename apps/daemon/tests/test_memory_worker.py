from tests.memory_turn_fixture import create_completed_user
import asyncio
import threading
from types import SimpleNamespace

import pytest


@pytest.fixture
def worker(tmp_path, monkeypatch):
    from services import config, digital_person
    from services.memory_worker import MemoryWorker
    monkeypatch.setattr(config, 'CONFIG_DIR', tmp_path)
    monkeypatch.setattr(digital_person, 'get_profile', lambda: SimpleNamespace(enabled=True))
    return MemoryWorker(object(), object())


async def test_worker_scans_before_consolidating_and_persists_status(worker, monkeypatch):
    from services import digital_person_memory as memory, digital_person_memory_index as index
    calls = []
    async def scan(projects, batch_size):
        calls.append(('scan', batch_size))
        return 3
    async def consolidate():
        calls.append(('consolidate',))
        return {'status': 'ready', 'processed': 2, 'created': 1}
    monkeypatch.setattr(memory, 'sync_projects', scan)
    monkeypatch.setattr(worker, '_consolidate', consolidate)
    await worker.sweep()
    status = await asyncio.to_thread(index.read_state, 'memory_worker')
    assert calls == [('scan', 100), ('consolidate',)]
    assert status['indexed'] == 3 and status['knowledge']['created'] == 1
    assert status['status'] == 'idle' and status['finished_at']


async def test_disabled_worker_does_not_index_or_call_model(worker, monkeypatch):
    from services import digital_person
    monkeypatch.setattr(digital_person, 'get_profile', lambda: SimpleNamespace(enabled=False))
    async def unexpected():
        pytest.fail('disabled memory must not call the model')
    monkeypatch.setattr(worker, '_consolidate', unexpected)
    assert (await worker.sweep())['status'] == 'disabled'


async def test_worker_failure_retries_without_logging_sensitive_error(worker, monkeypatch):
    from services import digital_person_memory as memory, digital_person_memory_index as index
    count = 0
    async def scan(*args, **kwargs):
        nonlocal count
        count += 1
        if count == 1:
            raise ValueError('private user message')
        return 0
    async def consolidate():
        return {'status': 'ready', 'processed': 0}
    monkeypatch.setattr(memory, 'sync_projects', scan)
    monkeypatch.setattr(worker, '_consolidate', consolidate)
    assert (await worker.sweep())['error_type'] == 'ValueError'
    assert (await worker.sweep())['status'] == 'idle'
    assert 'private user message' not in str(await asyncio.to_thread(index.read_state, 'memory_worker'))


async def test_worker_slow_profile_does_not_block_health(worker, monkeypatch):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from services import digital_person
    entered, release = threading.Event(), threading.Event()
    def slow():
        entered.set()
        release.wait(3)
        return SimpleNamespace(enabled=False)
    monkeypatch.setattr(digital_person, 'get_profile', slow)
    app = FastAPI()
    @app.get('/health')
    async def health():
        return {'ok': True}
    pending = asyncio.create_task(worker.sweep())
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/health'), .3)).status_code == 200
    finally:
        release.set()
        await pending


async def test_memory_executor_has_no_timer_and_caller_cancels_active_model(worker, monkeypatch):
    from services import digital_person_memory as memory
    entered, cancelled = asyncio.Event(), asyncio.Event()
    async def scan(*args, **kwargs): return 0
    async def consolidate():
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
    monkeypatch.setattr(memory, 'sync_projects', scan)
    monkeypatch.setattr(worker, '_consolidate', consolidate)
    assert not hasattr(worker, 'start') and not hasattr(worker, '_run')
    task=asyncio.create_task(worker.sweep())
    await asyncio.wait_for(entered.wait(),1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError): await task
    assert cancelled.is_set()


from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime


async def test_real_worker_backfills_extracts_and_makes_knowledge_searchable(runtime, monkeypatch):
    import json
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    from services.memory_worker import MemoryWorker
    from services import memory_query, digital_person_memory_index as index
    from engines.pydantic_ai.engine import PydanticAIEngine
    current, project, _ = runtime
    sid = (await current.main_session())['id']
    await current.projects.run_db(project.id, lambda _: create_completed_user(
        id='worker-evidence', session=sid, role='user', status='completed',
        content='北辰发布前要做数据库迁移演练。', created_at=utc_now()))
    monkeypatch.setattr(PydanticAIEngine, 'is_installed', classmethod(lambda cls: True))
    monkeypatch.setattr(PydanticAIEngine, 'is_configured', classmethod(lambda cls: True))
    async def extract(cls, prompt, **kwargs):
        evidence = json.loads(prompt.split('Evidence JSON:\n', 1)[1])['evidence']
        return json.dumps({'memories': [{'summary':'北辰发布前需要数据库迁移演练',
            'kind':'event', 'outcome':'stated', 'source_ids':[next(e['id'] for e in evidence if e['role']=='user')],
            'entities':[{'kind':'object','name':'北辰','aliases':['Polaris']}]}]})
    monkeypatch.setattr(PydanticAIEngine, 'run_simple', classmethod(extract))
    worker = MemoryWorker(current.projects, None)
    state = await worker.sweep()
    assert state['knowledge']['created'] == 1 and state['knowledge']['queue']['done'] == 2
    token = await memory_query.create_context(current.projects, 'local', session_id=sid, issuer_project_id=project.id)
    result = await memory_query.search(current.projects, token, query='Polaris')
    assert result['knowledge'][0]['summary'] == '北辰发布前需要数据库迁移演练'
    assert (await asyncio.to_thread(index.read_state, 'memory_worker'))['status'] == 'idle'


async def test_proactive_check_does_not_start_a_separate_memory_execution(runtime,monkeypatch):
    current,_,_=runtime
    calls=[]
    async def collect():
        calls.append('collect')
        return {'no_work':True,'conversation':[],'messages':[],'delegations':[]}
    async def forbidden(*args,**kwargs):pytest.fail('no separate extraction model')
    monkeypatch.setattr(current,'_collect',collect)
    monkeypatch.setattr('services.memory_knowledge._extract_with_runtime',forbidden)
    assert (await current.check())['status']=='silent'
    assert calls==[]


def test_daemon_does_not_start_a_separate_memory_scheduler():
    from pathlib import Path
    source=(Path(__file__).resolve().parents[1]/'main.py').read_text()
    assert 'memory_worker.start()' not in source
    assert 'MemoryWorker(project_manager' not in source


async def test_model_failure_is_visible_and_cooldown_survives_worker_recreation(worker,monkeypatch):
    from services import digital_person_memory_index as index
    from services.memory_worker import MemoryWorker
    import time
    calls=[]
    async def consolidate():
        calls.append(1)
        return {'status':'retry','processed':0,'created':0,'error':'ModelHTTPError','http_status':502}
    monkeypatch.setattr(worker,'_consolidate',consolidate)
    first=await worker.sweep(index_sources=False)
    assert first['status']=='retrying' and first['error_type']=='ModelHTTPError'
    assert first['retry_at']>time.time()
    fresh=MemoryWorker(worker.projects,worker.bus)
    monkeypatch.setattr(fresh,'_consolidate',consolidate)
    assert (await fresh.sweep(index_sources=False))['cooldown'] is True
    assert len(calls)==1
    await asyncio.to_thread(index.mutate_state,'memory_worker',lambda s:s.update(retry_at=0))
    async def recovered():return {'status':'completed','processed':1,'created':1}
    monkeypatch.setattr(fresh,'_consolidate',recovered)
    state=await fresh.sweep(index_sources=False)
    assert state['status']=='idle' and state['error_type'] is None and state['retry_at']==0


async def test_unified_assessment_model_failure_is_visible(runtime,monkeypatch):
    from tests.test_digital_person_runtime import seed_pending
    current,_,_=runtime
    await seed_pending(current)
    async def fail(ctx):raise RuntimeError('ModelHTTPError')
    monkeypatch.setattr(current,'_decide',fail)
    result=await current.check()
    assert result['status']=='failed' and result['error']=='ModelHTTPError'


async def test_scheduled_drain_stops_claiming_fresh_batches_after_model_failure(runtime,monkeypatch):
    current,_,store=runtime
    store.set('digital_person',{'enabled':True,'proactive_enabled':True})
    calls=[]
    async def check(**kwargs):
        calls.append(1)
        if len(calls)>1:return None
        return {'status':'failed','sources':{'indexed':100,'reflection_batch':[]}}
    monkeypatch.setattr(current,'check',check)
    await current._tick()
    assert len(calls)==1


async def test_old_extraction_backend_failure_does_not_affect_unified_notification(runtime,monkeypatch):
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    current,project,_=runtime
    sid=(await current.main_session())['id']
    await current.projects.run_db(project.id,lambda _:create_completed_user(id='independent-reflection',session=sid,role='user',status='completed',content='明确的新事项',created_at=utc_now()))
    async def sweep(*args,**kwargs):pytest.fail('old extraction backend must not be called')
    async def decide(ctx):
        if ctx.get('_load'): await ctx['_load']()
        return {'decision':'notify','kind':'work','summary':'核实后的新结果','source_ids':['independent-reflection']}
    monkeypatch.setattr('services.memory_knowledge._extract_with_runtime',sweep)
    monkeypatch.setattr(current,'_decide',decide)
    monkeypatch.setattr('services.digital_person_channels.get_bindings',lambda:[])
    result=await current.check()
    assert result['status']=='notified' and result['summary']=='核实后的新结果'
    assert result['memory_processing']['mode']=='unified' and 'memory_error' not in result
    assert await current.projects.run_db(project.id,lambda _:ChatMessage.select().where(ChatMessage.session==sid,ChatMessage.role=='assistant').order_by(ChatMessage.created_at.desc()).get().content)=='核实后的新结果'
