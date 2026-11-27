"""Whole-cycle failure guard and safe diagnostics, using real persistent storage."""
import asyncio
import pytest
from models.chat_session import ChatMessage
from services import digital_person
from services.digital_person_runtime import activity_failure_reason
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime
from tests.test_digital_person_unified import seed

@pytest.mark.parametrize(('error','expected'), [
    ('insufficient_quota api_key=super-secret', '供应商额度不足'),
    ('429 rate limit exceeded', '供应商请求限流'),
    ('401 invalid api key sk-secret', '供应商认证失败'),
    ('request timed out', '思考请求超时'),
    ('engine unavailable /Users/private', '思考引擎不可用'),
    ('Active check incomplete:error token=private', '主动思考运行失败，请检查供应商或引擎后重试'),
])
def test_safe_failure_reason(error, expected):
    assert activity_failure_reason({'error':error}) == expected

async def test_three_failed_cycles_disable_and_notify_once(runtime, monkeypatch):
    current, project, _ = runtime
    sid = await seed(current, project)
    calls = []
    async def fail(ctx):
        calls.append(1)
        raise RuntimeError('insufficient_quota token=private')
    monkeypatch.setattr(current, '_decide', fail)
    for i in range(3):
        await current._drain_assessments()
        assert digital_person.get_profile().reflection_enabled is (i < 2)
    await current._drain_assessments()
    await current._flush_reflection_shutdown()
    assert len(calls) == 3
    messages = await current.projects.run_db(project.id, lambda _: [m.content for m in ChatMessage.select().where(ChatMessage.session==sid, ChatMessage.role=='assistant')])
    notices = [m for m in messages if '连续 3 次运行失败' in m]
    assert len(notices) == 1
    assert '供应商额度不足' in notices[0]
    assert 'private' not in notices[0]
    state = await current.state()
    assert state['reflection_failures'] == 3
    # A new runtime loads the same state and does not replay the notice.
    from services.digital_person_runtime import DigitalPersonRuntime
    restarted = DigitalPersonRuntime(current.projects, current.chats, None, current.bus)
    await restarted._flush_reflection_shutdown()
    assert await current.projects.run_db(project.id, lambda _: ChatMessage.select().where(ChatMessage.session==sid,ChatMessage.role=='assistant').count()) == len(messages)
    profile = digital_person.get_profile().model_copy(update={'reflection_enabled':True})
    await asyncio.to_thread(digital_person.save_profile, profile)
    assert (await current.state())['reflection_failures'] == 0
    await current._drain_assessments()
    assert digital_person.get_profile().reflection_enabled
    assert (await current.state())['reflection_failures'] == 1

async def test_success_skip_cancel_and_duplicate_settlement(runtime):
    current, _, _ = runtime
    epoch = (await current.state()).get('reflection_epoch', '')
    async def settle(identifier, status, **extra):
        await current._finish_reflection_cycle({'id':identifier, 'status':status, **extra}, epoch)
    await settle('one', 'failed')
    await settle('one', 'failed')
    assert (await current.state())['reflection_failures'] == 1
    await settle('skip', 'silent', sources={'no_work':True})
    await settle('cancel', 'cancelled')
    assert (await current.state())['reflection_failures'] == 1
    await settle('two', 'failed')
    await settle('success', 'silent', processing={'messages':1})
    await settle('three', 'failed')
    assert (await current.state())['reflection_failures'] == 1
    assert digital_person.get_profile().reflection_enabled

async def test_old_cycle_cannot_disable_reenabled_profile(runtime):
    current, _, _ = runtime
    epoch = (await current.state()).get('reflection_epoch', '')
    await asyncio.to_thread(digital_person.save_profile, digital_person.get_profile().model_copy(update={'reflection_enabled':False}))
    await asyncio.to_thread(digital_person.save_profile, digital_person.get_profile().model_copy(update={'reflection_enabled':True}))
    await current._finish_reflection_cycle({'id':'old', 'status':'failed'}, epoch)
    assert (await current.state())['reflection_failures'] == 0

async def test_success_skip_cancel_and_reenable_reset(runtime):
    current, _, _ = runtime
    epoch = (await current.state()).get('reflection_epoch', '')
    async def finish(i, status, **extra):
        await current._finish_reflection_cycle({'id':str(i),'status':status,**extra}, epoch)
    await finish(1,'failed',error='timeout')
    await finish(2,'failed',error='timeout')
    await finish(3,'silent')
    await finish(4,'failed',error='timeout')
    await finish(4,'failed',error='timeout')
    await finish(5,'cancelled')
    await finish(6,'silent',sources={'no_work':True})
    assert (await current.state())['reflection_failures'] == 1
    assert digital_person.get_profile().reflection_enabled
    await asyncio.to_thread(digital_person.save_profile, digital_person.get_profile().model_copy(update={'reflection_enabled':False}))
    await asyncio.to_thread(digital_person.save_profile, digital_person.get_profile().model_copy(update={'reflection_enabled':True}))
    assert (await current.state())['reflection_failures'] == 0
    await current._finish_reflection_cycle({'id':'new','status':'failed','error':'timeout'}, (await current.state())['reflection_epoch'])
    assert (await current.state())['reflection_failures'] == 1

async def test_two_batches_settle_one_failed_cycle(runtime, monkeypatch):
    current, _, _ = runtime
    responses=iter([{'id':'batch1','status':'silent','sources':{'reflection_batch':[{'id':1}]}},
                    {'id':'batch2','status':'failed','error':'timeout'}])
    async def check(**kwargs):return next(responses)
    async def follow(profile):pass
    monkeypatch.setattr(current,'check',check)
    monkeypatch.setattr(current,'follow_delegations',follow)
    await current._drain_assessments()
    assert (await current.state())['reflection_failures']==1

async def test_actual_engine_error_is_classified_and_retry_counts_once(runtime, monkeypatch):
    current, project, _ = runtime
    await seed(current, project)
    async def invoke(*args,**kwargs):raise RuntimeError('429 rate limit exceeded token=private')
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    result=await current.check()
    assert result['status']=='failed'
    detail=await current.run_detail(result['id'])
    assert detail['failure_reason']=='供应商请求限流'
    assert 'private' not in str(detail)
    assert '429' not in str({key:detail.get(key) for key in ('error','failure_reason','summary','draft_summary')})
    assert (await current.state())['reflection_failures']==1
    assert 'private' not in str(await current.overview())

async def test_notification_retry_survives_publication_failure(runtime, monkeypatch):
    current, project, _ = runtime
    sid=await seed(current,project)
    epoch=(await current.state()).get('reflection_epoch','')
    for i in range(2):await current._finish_reflection_cycle({'id':str(i),'status':'failed','error':'timeout'},epoch)
    original=current.bus.publish
    async def fail(event):raise RuntimeError('disconnected')
    monkeypatch.setattr(current.bus,'publish',fail)
    with pytest.raises(RuntimeError):await current._finish_reflection_cycle({'id':'third','status':'failed','error':'timeout'},epoch)
    assert not digital_person.get_profile().reflection_enabled
    assert (await current.state()).get('reflection_shutdown')
    monkeypatch.setattr(current.bus,'publish',original)
    await current._tick()
    await current._tick()
    count=await current.projects.run_db(project.id,lambda _:ChatMessage.select().where(ChatMessage.session==sid,ChatMessage.content.contains('连续 3 次运行失败')).count())
    assert count==1
    assert not (await current.state()).get('reflection_shutdown')

async def test_slow_failure_settlement_keeps_loop_responsive(runtime,monkeypatch):
    import threading
    import time
    current,_,_=runtime
    from services import digital_person_memory_index as index
    original=index.mutate_state
    entered=threading.Event()
    def slow(*args,**kwargs):
        entered.set();time.sleep(.15)
        return original(*args,**kwargs)
    monkeypatch.setattr(index,'mutate_state',slow)
    job=asyncio.create_task(current._finish_reflection_cycle({'id':'slow','status':'failed','error':'timeout'},''))
    while not entered.is_set():await asyncio.sleep(.001)
    await asyncio.sleep(.01)
    assert not job.done()
    await job

async def test_model_repairs_count_once_after_final_failure(runtime,monkeypatch):
    current, project, _=runtime
    await seed(current,project)
    calls=[]
    async def invoke(*args,**kwargs):
        calls.append(1)
        return 'invalid JSON',[], 'engine-thread'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    assert (await current.check())['status']=='failed'
    assert len(calls)==2
    assert (await current.state())['reflection_failures']==1
    from services.digital_person_runtime import DigitalPersonRuntime
    resumed=DigitalPersonRuntime(current.projects,current.chats,None,current.bus)
    assert (await resumed.state())['reflection_failures']==1

async def test_delivery_failures_count_once_but_missing_targets_do_not(runtime):
    current,_,_=runtime
    for i in range(2):
        await current._finish_reflection_cycle({'id':str(i),'status':'delivery_failed',
            'deliveries':[{'status':'failed','error':'timeout'},{'status':'failed','error':'timeout'}]},'')
        assert (await current.state())['reflection_failures']==i+1
    assert digital_person.get_profile().reflection_enabled
    await current._finish_reflection_cycle({'id':'third','status':'delivery_failed',
        'deliveries':[{'status':'failed','error':'timeout'}]},'')
    assert not digital_person.get_profile().reflection_enabled
    await asyncio.to_thread(digital_person.save_profile, digital_person.get_profile().model_copy(update={'reflection_enabled':True}))
    await current._finish_reflection_cycle({'id':'no-targets','status':'delivery_failed','deliveries':[]},(await current.state())['reflection_epoch'])
    assert (await current.state())['reflection_failures']==0
