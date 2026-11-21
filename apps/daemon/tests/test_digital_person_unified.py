from tests.memory_turn_fixture import assessment_access
from tests.memory_turn_fixture import create_completed_user
import asyncio
import json
from datetime import timedelta
import pytest
from models.chat_session import ChatMessage
from models.fields import utc_now
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime
from services import digital_person_memory_index as index

async def seed(current,project,mid='new-event',when=None):
    sid=(await current.main_session())['id']
    await current.projects.run_db(project.id,lambda _:create_completed_user(id=mid,session=sid,role='user',author_id='owner',author_name='用户',content='发布前必须先演练数据库迁移，这是我明确的要求。',status='completed',created_at=when or utc_now()-timedelta(minutes=2)))
    return sid

async def test_automatic_thinking_switch_preserves_manual_and_delegation_checks_share_cycle(runtime,monkeypatch):
    current,project,store=runtime
    store.set('digital_person',{'enabled':True,'reflection_enabled':False,'proactive_enabled':True})
    await seed(current,project)
    calls=[]
    async def follow(profile):calls.append('delegation')
    async def decide(ctx):
        if ctx.get('_load'): await ctx['_load']()
        calls.append('thinking')
        return {'decision':'silent','summary':'done','source_ids':[]}
    monkeypatch.setattr(current,'follow_delegations',follow)
    monkeypatch.setattr(current,'_decide',decide)
    await current._tick()
    assert calls==[]
    assert (await current.check(manual=True))['status']=='silent'
    assert calls==['delegation','thinking']
    store.set('digital_person',{'enabled':True,'reflection_enabled':True,'proactive_enabled':True})
    await current.mutate(lambda s:s.update(last_check=(utc_now()-timedelta(minutes=6)).isoformat()))
    await current._tick()
    assert calls==['delegation','thinking','delegation']

async def test_disabling_automatic_thinking_stops_drain_after_current_batch(runtime,monkeypatch):
    current,_,store=runtime
    calls=[]
    async def follow(profile):calls.append('delegation')
    async def check(**kwargs):
        calls.append('thinking')
        store.set('digital_person',{'enabled':True,'reflection_enabled':False})
        return {'status':'silent','sources':{'reflection_batch':[{'id':1}]}}
    monkeypatch.setattr(current,'follow_delegations',follow)
    monkeypatch.setattr(current,'check',check)
    await current._drain_assessments()
    assert calls==['delegation','thinking']


async def test_automatic_cycle_limits_to_two_batches_then_waits_for_interval(runtime, monkeypatch):
    current, project, store = runtime
    store.set('digital_person', {'enabled':True, 'reflection_enabled':True,
                               'proactive_enabled':True, 'proactive_interval_minutes':5,
                               'memory_batch_size':2})
    sid = (await current.main_session())['id']
    base = utc_now() - timedelta(minutes=2)
    def prepare(_):
        for i in range(3):
            create_completed_user(id=f'bounded-{i}', session=sid, role='user', status='completed',
                                  content=f'第{i}条独立新事件', created_at=base+timedelta(seconds=i))
    await current.projects.run_db(project.id, prepare)
    batches = []
    async def decide(context):
        await context['_load']()
        batches.append([m['id'] for m in context['conversation']])
        return dict(decision='silent', summary='本批处理完成', source_ids=[])
    monkeypatch.setattr(current, '_decide', decide)
    await current._tick()
    assert len(batches) == 2
    with index.connect() as db:
        assert db.execute("SELECT count(*) FROM memories WHERE memory_status='pending'").fetchone()[0] == 2
    last = (await current.state())['last_check']
    from datetime import datetime
    last = datetime.fromisoformat(str(last))
    await current._tick(last + timedelta(minutes=4, seconds=59))
    assert len(batches) == 2
    await current._tick(last + timedelta(minutes=5))
    assert len(batches) == 3
    assert len({mid for batch in batches for mid in batch}) == 6
    with index.connect() as db:
        assert db.execute("SELECT count(*) FROM memories WHERE memory_status='pending'").fetchone()[0] == 0


@pytest.mark.parametrize('shared',[True,False])
async def test_reflection_is_an_internal_event_not_a_user_message(runtime,monkeypatch,shared):
    from types import SimpleNamespace
    current,project,store=runtime
    queue=current.bus.subscribe()
    monkeypatch.setattr('agent_assistants.base.get_effective_actor',lambda:SimpleNamespace(
        actor_id='human',user_name='真实用户',username='human',device_id='device',device_name='电脑'))
    store.set('digital_person',{'enabled':True,'proactive_shared_context':shared})
    calls=[]
    async def invoke(engine,model,cwd,prompt,session_id,*args,**kwargs):
        calls.append((prompt,session_id,kwargs))
        assert kwargs.get('internal_event')=='digital_person.reflection'
        assert 'User:' not in prompt
        return '{"decision":"silent","summary":"done","source_ids":[]}',[],f'native-{len(calls)}'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    await current._decide({'event_marker':'first'})
    sid=(await current.state())['check_session_id']
    await current._decide({'event_marker':'second'})
    assert calls[1][1]==('native-1' if shared else None)
    def inspect(_):
        rows=list(ChatMessage.select().where(ChatMessage.session==sid))
        assert not any(m.role=='user' for m in rows)
        triggers=[m for m in rows if m.role=='system']
        assert len(triggers)==2
        assert all(m.author_type=='internal' and not m.initiated_by_user_id for m in triggers)
    await current.projects.run_db(project.id,inspect)
    events=[]
    while not queue.empty():
        events.append(queue.get_nowait())
    starts=[e for e in events if e.get('type')=='TEXT_MESSAGE_START']
    assert sum(e.get('role')=='system' for e in starts)==2
    assert not any(e.get('role')=='user' for e in starts)
    assert all(not e.get('actor') for e in starts if e.get('role')=='system')
    current.bus.unsubscribe(queue)

async def test_interrupted_internal_event_does_not_invent_a_user_continuation(runtime,monkeypatch):
    current,project,store=runtime
    store.set('auto_resume_interrupted_chats',True)
    sid=(await current.main_session())['id']
    def seed_interruption(_):
        ChatMessage.create(id='trigger',session=sid,role='system',author_type='internal',
            content='background event',created_at=utc_now()-timedelta(seconds=1))
        ChatMessage.create(id='interrupted',session=sid,role='assistant',status='stopped',
            content='',created_at=utc_now())
    await current.projects.run_db(project.id,seed_interruption)
    current.chats._restart_candidates=[(project.id,sid,'interrupted')]
    def forbidden(*args,**kwargs):pytest.fail('background recovery must not submit a user message')
    monkeypatch.setattr(current.chats,'submit_message',forbidden)
    assert await current.chats.resume_interrupted_chats()==0

async def test_long_new_event_is_complete_after_pending(runtime,monkeypatch):
    from services import memory_query
    current,project,_=runtime
    await seed(current,project)
    body='这是新的交流内容。'*100+'结尾要求：发布前做迁移演练。'
    await current.projects.run_db(project.id,lambda _:ChatMessage.update(content=body).where(ChatMessage.id=='new-event').execute())
    async def invoke(*args,**kwargs):
        token=await assessment_access(current)
        assert body not in args[3]
        ctx=await memory_query.pending(current.projects,token)
        assert ctx['conversation'][0]['content']==body
        assert 'needs_read' not in ctx['conversation'][0]
        return json.dumps({'decision':'silent','summary':'已评估完整交流','source_ids':[]}),[], 'native-session'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    result=await current.check()
    assert result['status']=='silent',result
    with index.connect() as db:
        assert db.execute('select count(*) from digital_reflections').fetchone()[0]>0

async def test_discard_resets_native_history_even_when_context_is_shared(runtime,monkeypatch):
    from services import digital_person_assessment as assessment
    current,project,store=runtime
    store.set('digital_person',{'enabled':True,'proactive_shared_context':True})
    calls=[]
    async def invoke(engine,model,cwd,prompt,session_id,*args,**kwargs):
        calls.append((prompt,session_id))
        return '{"decision":"silent","summary":"done","source_ids":[]}',[],f'native-{len(calls)}'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    await current._decide({'old_private_input':'OLD_HISTORY_SENTINEL'})
    await asyncio.to_thread(assessment.skip_before,utc_now().isoformat(),[project.id])
    await current._decide({'new_input':'new'})
    assert calls[1][1] is None
    assert 'OLD_HISTORY_SENTINEL' not in calls[1][0]
    assert len((await current.state())['check_sessions'])==1

async def test_one_configured_engine_call_stores_memory_relationship_and_notice(runtime,monkeypatch):
    current,project,_=runtime
    await current.mutate(lambda s:s.update(assessment_live_since=(utc_now()-timedelta(days=1)).isoformat()))
    sid=await seed(current,project)
    calls=[]
    async def invoke(*args,**kwargs):
        calls.append((args,kwargs))
        from services import memory_query
        token=await assessment_access(current)
        assert 'Data to reflect on:' not in args[3]
        ctx=await memory_query.pending(current.projects,token)
        mid=ctx['conversation'][0]['memory_ids'][0]
        return json.dumps({'decision':'notify','kind':'social','summary':'记住了，下一次发布先做迁移演练。','source_ids':['new-event'],
            'memories':[{'summary':'发布前先演练数据库迁移','kind':'preference','outcome':'stated','source_ids':[mid],
                         'entities':[{'kind':'event','name':'数据库迁移演练','aliases':['迁移演练']}],
                         'relations':[], 'event_time':None}],
            'relationship_updates':[{'source_ids':['new-event'],'affinity_delta':1,'emotion':'warm','valence':10,'arousal':10,'reason':'有依据的合作互动'}]}),[], 'native-session'
    async def forbidden(*args,**kwargs):pytest.fail('must not invoke a separate extraction model')
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    monkeypatch.setattr('services.memory_knowledge._extract_with_runtime',forbidden)
    monkeypatch.setattr('services.digital_person_channels.get_bindings',lambda:[])
    result=await current.check()
    assert result['status']=='notified',result
    assert result['memory_processing']['knowledge']['created']==1
    assert result['relationship_updates'][0]['affinity']==51
    assert result['deliveries'][0]['session_id']==sid
    await current.check()
    assert len(calls)==1
    with index.connect() as db:
        assert db.execute('select count(*) from memory_knowledge').fetchone()[0]==1
        assert db.execute("select count(*) from memory_entities where canonical='数据库迁移演练'").fetchone()[0]==2

async def test_initial_history_is_processed_once_without_stale_contact_or_affinity(runtime,monkeypatch):
    current,project,_=runtime
    await seed(current,project,when=utc_now()-timedelta(days=20))
    calls=[]
    async def decide(ctx):
        if ctx.get('_load'): await ctx['_load']()
        calls.append(ctx)
        assert ctx['historical_batch'] is True
        return {'decision':'notify','kind':'social','summary':'不要把过时的发布安排再通知','source_ids':['new-event'],
                'relationship_updates':[{'source_ids':['new-event'],'affinity_delta':2,'emotion':'happy','valence':10,'arousal':10,'reason':'历史不补加分'}], 'memories':[]}
    async def forbidden(*args):pytest.fail('historical bootstrap must not notify')
    monkeypatch.setattr(current,'_decide',decide)
    monkeypatch.setattr(current,'_notify',forbidden)
    result=await current.check()
    assert result['status']=='silent' and result['relationship_updates']==[]
    await current.check()
    assert len(calls)==1

async def test_invalid_memory_keeps_entire_batch_pending(runtime,monkeypatch):
    current,project,_=runtime
    await seed(current,project)
    async def decide(ctx):
        if ctx.get('_load'): await ctx['_load']()
        return {'decision':'silent','summary':'invalid','source_ids':[],
        'memories':[{'summary':'假的事实','kind':'fact','outcome':'stated','source_ids':['memory:999999']}]}
    monkeypatch.setattr(current,'_decide',decide)
    result=await current.check()
    assert result['status']=='failed',result
    from services import digital_person_reflection as reflection
    rows=await asyncio.to_thread(reflection.pending,project.id)
    assert rows and rows[0]['source_message_id']=='new-event'
    with index.connect() as db:
        assert db.execute('select count(*) from memory_knowledge').fetchone()[0]==0

async def test_other_project_terminal_task_is_assessed_by_same_engine_once(runtime,monkeypatch,tmp_path):
    from models import Task,Message
    current,_,_=runtime
    other=await asyncio.to_thread(current.projects.init_project,tmp_path/'task-project')
    def write(_):
        Task.create(id='done-task',title='发布',cwd=str(other.path),created_at=utc_now(),updated_at=utc_now())
        message=Message.create(id='done-result',task='done-task',step_key='verify',role='assistant',content='部署失败：缺少迁移，修复后回归通过。',run_status='succeeded',position=1,created_at=utc_now(),ended_at=utc_now())
        from services.digital_person_memory import capture_task_completion
        capture_task_completion(other.id,message)
    await current.projects.run_db(other.id,write)
    calls=[]
    async def decide(ctx):
        if ctx.get('_load'): await ctx['_load']()
        calls.append(ctx)
        assert ctx['origin_project_id']==other.id and ctx['source_kind']=='task'
        return {'decision':'silent','summary':'已解读执行结果','source_ids':[], 'memories':[]}
    monkeypatch.setattr(current,'_decide',decide)
    assert (await current.check())['status']=='silent'
    await current.check()
    assert len(calls)==1


def test_contact_interval_is_explicit_and_no_hidden_daily_quota():
    from services.digital_person_companion import contact_policy
    now=utc_now()
    contacts={'contacts':[{'at':(now-timedelta(minutes=20+i)).isoformat()} for i in range(3)]}
    assert contact_policy(contacts,now-timedelta(minutes=2),now,interval_minutes=5)['allowed']
    assert not contact_policy(contacts,now-timedelta(minutes=2),now,interval_minutes=60)['allowed']


async def test_correction_requires_on_demand_read_and_supersedes_prior_memory(runtime,monkeypatch):
    from services import memory_query
    current,project,_=runtime
    sid=await seed(current,project)
    calls=[]
    async def invoke(*args,**kwargs):
        token=await assessment_access(current)
        ctx=await memory_query.pending(current.projects,token)
        calls.append(ctx)
        source=ctx['conversation'][0]['memory_ids'][0]
        item={'summary':'发布前必须演练迁移' if len(calls)==1 else '实验项目发布前可跳过迁移演练',
              'kind':'preference','outcome':'stated','source_ids':[source]}
        if len(calls)==2:
            token=await assessment_access(current)
            old=await memory_query.search(current.projects,token,query='迁移演练')
            assert old['knowledge']
            await memory_query.read(current.projects,token,old['knowledge'][0]['id'],limit=6000)
            item['supersedes']=[old['knowledge'][0]['id']]
        return json.dumps({'decision':'silent','summary':'已整理用户要求','source_ids':[], 'memories':[item]}),[], 'native-session'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    assert (await current.check())['status']=='silent'
    await current.projects.run_db(project.id,lambda _:create_completed_user(id='correction',session=sid,role='user',author_id='owner',content='纠正一下：实验项目可以跳过迁移演练。',status='completed',created_at=utc_now()))
    result=await current.check()
    assert result['status']=='silent',result
    assert len(calls)==2
    with index.connect() as db:
        assert [r[0] for r in db.execute('select state from memory_knowledge order by id')]==['superseded','active']
        change=db.execute("select old_id,new_id,operation from memory_changes where old_id is not null").fetchone()
        assert tuple(change)==(1,2,'supersede')
        # A replacement retains evidence for the supported prior conditions.
        assert db.execute('select count(*) from memory_knowledge_sources where knowledge_id=2').fetchone()[0]==2


async def test_empty_small_talk_creates_no_knowledge_and_crash_retries_only_unfinished(runtime,monkeypatch):
    from services.digital_person_runtime import DigitalPersonRuntime
    current,project,_=runtime
    await seed(current,project)
    calls=[]
    async def decide(ctx):
        if ctx.get('_load'): await ctx['_load']()
        calls.append(ctx)
        if len(calls)==1:raise RuntimeError('simulated engine interruption')
        return {'decision':'silent','summary':'没有可持久保留的信息','source_ids':[], 'memories':[]}
    monkeypatch.setattr(current,'_decide',decide)
    assert (await current.check())['status']=='failed'
    fresh=DigitalPersonRuntime(current.projects,current.chats,None,current.bus)
    monkeypatch.setattr(fresh,'_decide',decide)
    assert (await fresh.check())['status']=='silent'
    await fresh.check()
    assert len(calls)==2
    with index.connect() as db:
        assert db.execute('select count(*) from memory_knowledge').fetchone()[0]==0
        assert db.execute("select count(*) from memory_extraction_jobs where status='done'").fetchone()[0]==2


async def test_invalid_second_candidate_rolls_back_first_candidate_and_progress(runtime):
    from services import digital_person_assessment as assessment
    current,project,_=runtime
    await seed(current,project)
    ctx=await current._collect()
    mid=ctx['conversation'][0]['memory_ids'][0]
    good={'summary':'可追溯的要求','kind':'preference','outcome':'stated','source_ids':[mid]}
    bad={'summary':'没有来源','kind':'fact','outcome':'stated','source_ids':['memory:999999']}
    with pytest.raises(ValueError):
        await asyncio.to_thread(assessment.commit,ctx['reflection_batch'],[good,bad],'invalid-batch')
    with index.connect() as db:
        assert db.execute('select count(*) from memory_knowledge').fetchone()[0]==0
        assert db.execute('select count(*) from digital_reflections').fetchone()[0]==0


async def test_long_assessment_keeps_one_cycle_without_independent_delegation_poll(runtime,monkeypatch):
    current,_,store=runtime
    store.set('digital_person',{'enabled':True,'proactive_enabled':True,'delegation_interval_seconds':60})
    entered,release=asyncio.Event(),asyncio.Event()
    checks=[];polls=[]
    async def check(**kwargs):
        checks.append(1);entered.set();await release.wait()
        return {'status':'silent','sources':{}}
    async def follow(profile=None):polls.append(1)
    monkeypatch.setattr(current,'check',check)
    monkeypatch.setattr(current,'follow_delegations',follow)
    now=utc_now()
    await current._tick(now,background=True)
    await asyncio.wait_for(entered.wait(),1)
    await current._tick(now+timedelta(seconds=61),background=True)
    assert len(checks)==1 and len(polls)==1
    release.set()
    await current._cycle_task


async def test_stop_cancels_background_cycle_between_model_phases(runtime,monkeypatch):
    current,_,store=runtime
    store.set('digital_person',{'enabled':True,'proactive_enabled':True})
    entered=asyncio.Event()
    async def check(**kwargs):entered.set();await asyncio.Event().wait()
    monkeypatch.setattr(current,'check',check)
    await current._tick(background=True)
    await asyncio.wait_for(entered.wait(),1)
    try:
        await current.stop_check()
        assert current._cycle_task.done()
    finally:
        current._cycle_task.cancel()
        await asyncio.gather(current._cycle_task,return_exceptions=True)


async def test_foreign_project_channel_contact_stays_in_its_source_project(runtime,monkeypatch,tmp_path):
    current,home,_=runtime
    other=await asyncio.to_thread(current.projects.init_project,tmp_path/'channel-project')
    sid=await current.projects.run_db(other.id,lambda _:current.chats.create_session(other.id)['id'])
    await current.mutate(lambda s:s['runs'].append({'id':'foreign-notice','trigger':'interval','kind':'social',
        'origin_session_id':sid,'sources':{'origin_project_id':other.id,'companion':{'scope':'channel:peer'}}}))
    monkeypatch.setattr('services.digital_person_channels.get_bindings',lambda:[])
    receipts=await current._notify('来源联系人自己的消息',['source'],'foreign-notice')
    assert receipts[0]['status']=='delivered',receipts
    assert receipts[0]['project_id']==other.id
    assert await current.projects.run_db(other.id,lambda _:ChatMessage.select().where(ChatMessage.session==sid).get().content)=='来源联系人自己的消息'
    assert await current.projects.run_db(home.id,lambda _:ChatMessage.select().where(ChatMessage.session==sid).count())==0


async def test_old_due_followup_does_not_override_pending_message_batch(runtime,monkeypatch):
    from services.digital_person_companion import reflect
    current,project,_=runtime
    sid=await seed(current,project,when=utc_now()-timedelta(days=3))
    def due(state):
        reflect(state,'local',{'thought':{'content':'该问问发布情况了','source_ids':['new-event'],'after_minutes':1}},
                {'new-event'},utc_now()-timedelta(minutes=2))
        state['companions']['local']['thought']['origin_session_id']=sid
    await current.mutate(due)
    context=await current._collect()
    assert context['reflection_batch']
    assert 'thought' not in context['companion']
    assert context['thought_sources']==[]


async def test_registered_delegation_result_is_internal_and_follower_keeps_notification_ownership(runtime,monkeypatch):
    current,project,_=runtime
    sid=await seed(current,project)
    await current.mutate(lambda s:s['delegations'].append({'id':'delegated','project_id':project.id,'session_id':sid,
        'origin_session_id':sid,'message_id':'new-event','notified':False}))
    async def decide(ctx):
        if ctx.get('_load'): await ctx['_load']()
        return {'decision':'notify','kind':'work','summary':'执行结果不重复发','source_ids':['new-event'],'memories':[]}
    followed=[]
    async def follow(profile):followed.append(1)
    monkeypatch.setattr(current,'follow_delegations',follow)
    monkeypatch.setattr(current,'_decide',decide)
    result=await current.check()
    assert result['status']=='silent' and result['deliveries']==[]
    assert (await current.state())['delegations'][0]['notified'] is False
    assert followed==[1]
    assert result['memory_processing']['knowledge']['processed']==2


async def test_slow_unified_commit_keeps_health_api_responsive(runtime,monkeypatch):
    import threading
    from fastapi import FastAPI
    from httpx import AsyncClient,ASGITransport
    from services import digital_person_assessment as assessment
    current,project,_=runtime
    await seed(current,project)
    entered,release=threading.Event(),threading.Event()
    original=assessment.commit
    def slow(*args,**kwargs):
        entered.set()
        assert release.wait(2)
        return original(*args,**kwargs)
    async def decide(ctx):
        if ctx.get('_load'): await ctx['_load']()
        return {'decision':'silent','summary':'完成','source_ids':[],'memories':[]}
    monkeypatch.setattr(assessment,'commit',slow)
    monkeypatch.setattr(current,'_decide',decide)
    app=FastAPI()
    @app.get('/health')
    async def health():return {'ok':True}
    task=asyncio.create_task(current.check())
    try:
        assert await asyncio.to_thread(entered.wait,1)
        async with AsyncClient(transport=ASGITransport(app),base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/health'),.3)).status_code==200
    finally:
        release.set()
        result=await task
    assert result['status']=='silent',result


async def test_discard_prior_history_persists_and_only_assesses_new_events(runtime,monkeypatch):
    from services import digital_person_assessment as assessment
    from services.digital_person_runtime import DigitalPersonRuntime
    current,project,_=runtime
    sid=await seed(current,project,mid='old',when=utc_now()-timedelta(days=2))
    await current._collect()  # Already indexed old evidence must also be skipped.
    cutoff=utc_now()
    await current.projects.run_db(project.id,lambda _:create_completed_user(id='unindexed-old',session=sid,role='user',content='未索引的旧消息',status='completed',created_at=cutoff-timedelta(hours=2)))
    await asyncio.to_thread(assessment.skip_before,cutoff.isoformat(),[project.id])
    await current.projects.run_db(project.id,lambda _:create_completed_user(id='after-cutoff',session=sid,role='user',content='截止点之后的新事件',status='completed',created_at=utc_now()))
    fresh=DigitalPersonRuntime(current.projects,current.chats,None,current.bus)
    calls=[]
    async def decide(ctx):
        if ctx.get('_load'): await ctx['_load']()
        calls.append(ctx)
        assert [m['id'] for m in ctx['conversation']]==['after-cutoff','fixture-reply-after-cutoff']
        return {'decision':'silent','summary':'处理新事件','source_ids':[],'memories':[]}
    monkeypatch.setattr(fresh,'_decide',decide)
    assert (await fresh.check())['status']=='silent'
    assert (await fresh.check())['sources']['no_work']
    assert len(calls)==1
    assert await current.projects.run_db(project.id,lambda _:ChatMessage.select().where(ChatMessage.session==sid).count())==6


async def test_old_inflight_result_cannot_apply_after_history_discard(runtime,monkeypatch):
    from services import digital_person_assessment as assessment
    current,project,_=runtime
    await seed(current,project)
    async def decide(ctx):
        if ctx.get('_load'): await ctx['_load']()
        await asyncio.to_thread(assessment.skip_before,utc_now().isoformat(),[project.id])
        return {'decision':'notify','kind':'social','summary':'旧结果不能再发','source_ids':['new-event'],'mood':'happy',
                'relationship_updates':[{'source_ids':['new-event'],'affinity_delta':2,'emotion':'happy','valence':10,'arousal':10,'reason':'不能应用'}],
                'memories':[{'summary':'旧偏好不能再保存','kind':'preference','outcome':'stated','source_ids':ctx['conversation'][0]['memory_ids']}]}
    monkeypatch.setattr(current,'_decide',decide)
    result=await current.check()
    assert result['status']=='failed'
    assert result['relationship_updates']==[] and result['deliveries']==[]
    with index.connect() as db:
        assert db.execute('select count(*) from memory_knowledge').fetchone()[0]==0
        assert db.execute("select count(*) from memory_extraction_jobs where status='done'").fetchone()[0]==2


async def test_old_due_thought_does_not_reopen_discarded_history(runtime):
    from services import digital_person_assessment as assessment
    from services.digital_person_companion import reflect
    current,project,_=runtime
    await seed(current,project)
    await current.mutate(lambda s:reflect(s,'local',{'thought':{'content':'旧事后续','source_ids':['new-event'],'after_minutes':1}},
                                       {'new-event'},utc_now()-timedelta(minutes=3)))
    await asyncio.to_thread(assessment.skip_before,utc_now().isoformat(),[project.id])
    assert (await current._collect())['no_work']
