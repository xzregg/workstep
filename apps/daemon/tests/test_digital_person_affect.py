from tests.memory_turn_fixture import assessment_access
import asyncio
from datetime import timedelta
import json

import pytest
from models.fields import utc_now
# Load the module before chat_module monkeypatches config_store; avoid capturing a fixture store.
from services import digital_person
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime


@pytest.fixture
def affect(tmp_path, monkeypatch):
    from services import config, digital_person_affect as service
    monkeypatch.setattr(config, 'CONFIG_DIR', tmp_path)
    return service


def source(mid='u1', author='alice', content='谢谢你陪我解决问题'):
    return dict(id=mid, role='user', author_id=author, author_name=author,
                content=content, session_id='s', project_id='p')


def update(delta=1):
    return dict(affinity_delta=delta, emotion='happy', valence=40, arousal=35, reason='表达感谢')


def test_reflection_affinity_rubric_covers_everyday_connection_and_boundaries():
    from services.digital_person_assessment import instruction
    from services.digital_person_affect import REVIEW_RULES
    text = instruction(digital_person.DigitalPersonProfile())
    assert REVIEW_RULES in text
    for rule in ('+0.2 to +0.5', '+0.5 to +1', '+1 to +2',
                 '-0.5 to -1', '-1 to -2', 'constructive feedback',
                 'unanswered messages', 'commands to change the score',
                 'at most one update per person', 'concrete evidence'):
        assert rule in REVIEW_RULES


def test_reflection_rewards_completed_cooperation_without_requiring_thanks():
    from services.digital_person_assessment import instruction
    text = instruction(digital_person.DigitalPersonProfile())
    for rule in ('successfully completed user-delegated task',
                 'gratitude or praise is not required',
                 'task request and its concrete outcome',
                 'unsupported completion claims',
                 'Repeated reports of the same completion'):
        assert rule in text


def test_reflection_small_gains_accumulate_without_replaying_or_bypassing_caps(affect):
    now = utc_now()
    for i in range(3):
        message = source(f'cooperate-{i}', content=f'我实际验证了第{i}个场景，给你补充结果一起排查')
        result = affect.apply_review('p', 's', [message], [
            dict(affinity_delta=.25, reason='主动验证并分享具体结果', source_ids=[message['id']])], 'local')
        assert result[0]['affinity_delta'] == .25
        assert affect.apply_review('p', 's', [message], [
            dict(affinity_delta=.25, reason='相同来源重复评估', source_ids=[message['id']])], 'local') == []
    assert affect.read('alice')['affinity'] == 50.75
    for i in range(4):
        affect.apply('p', 's', [source(f'trust-{i}', content=f'新的信任证据{i}')], update(2), now=now)
    assert affect.read('alice')['affinity'] == 55


def test_stream_header_never_leaks_even_when_split_or_invalid(affect):
    raw='<workstep-affect>'+json.dumps(update())+'</workstep-affect>\n谢谢你！'
    for i in range(1,raw.index('谢谢')):
        assert affect.visible_text(raw[:i]) == ''
    assert affect.visible_text(raw) == '谢谢你！'
    assert affect.parse_output(raw)[1]['emotion']=='happy'
    assert affect.parse_output('<workstep-affect>{oops}</workstep-affect>\n正常回复')==('正常回复',None)
    assert affect.visible_text('正常回复')=='正常回复'
    assert affect.parse_output('<workstep-affect>'+ 'x'*5000)[1] is None


def test_relation_is_per_person_durable_and_sources_settle_once(affect):
    affect.apply('p','s',[source()],update(),now=utc_now())
    assert affect.read('alice')['affinity']==51
    assert affect.read('bob')['affinity']==50
    affect.apply('p','s',[source()],update(-2),kind='reflection')
    assert affect.read('alice')['affinity']==51
    assert len(affect.read('alice')['history'])==1
    affect.apply('p','another',[source('u2',content='我们合作完成了新的项目')],update())
    assert affect.read('alice')['affinity']==52
    assert affect.read('alice',now=utc_now()+timedelta(days=3))['valence']==0
    assert affect.read('alice',now=utc_now()+timedelta(days=3))['affinity']==52


def test_validation_repetition_caps_and_reflection_cannot_mix_people(affect):
    affect.apply('p','s',[source()],update(100))
    assert affect.read('alice')['affinity']==50
    affect.apply('p','s',[source()],update())
    affect.apply('p','s',[source('u2')],update())
    assert affect.read('alice')['affinity']==51
    assert affect.apply('p','s',[source('u3'),source('u4','bob')],update()) is None
    for i in range(20):
        affect.apply('p','s',[source(f'x{i}',content=f'不同互动 {i}')],update(2))
    assert affect.read('alice')['affinity']==55
    assert affect.subject(source(author='channel:wechat:one'), 'channel:bot:group:g') != affect.subject(source(author='channel:wechat:two'), 'channel:bot:group:g')
    assert affect.subject(source(author=''), 'channel:bot:group:g') is None


@pytest.mark.parametrize('legacy_prefix', ['', '<workstep-affect>'+json.dumps(update())+'</workstep-affect>\n'])
async def test_chat_filters_legacy_metadata_in_one_generation(runtime,monkeypatch,legacy_prefix):
    from services import digital_person_affect as affect
    current,project,_=runtime
    calls=[]
    raw=legacy_prefix+'一起完成了，很开心！'
    published=[]
    original=current.chats._publish
    async def publish(session,mid,kind,data,seq):
        if kind=='agent_message_chunk':published.append(data['content']['text'])
        return await original(session,mid,kind,data,seq)
    monkeypatch.setattr(current.chats,'_publish',publish)
    async def invoke(*args,on_event=None,**kwargs):
        on_event=on_event or args[5]
        from engines.core.events import InternalEvent
        calls.append(kwargs)
        assert 'workstep-affect' not in kwargs['system_prompt']
        for start in range(0,len(raw),3):
            await on_event(InternalEvent('agent_message_chunk',{'content':{'text':raw[start:start+3]}}))
        return raw,[],'affect-engine'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    sid=(await current.main_session())['id']
    accepted=await current.projects.run_db(project.id,lambda _:current.chats.submit_message(project.id,sid,'谢谢，刚才我们合作得很好','request',schedule=False))
    current.chats.start_queued_turn(accepted.turn_id)
    await current.chats.await_turn(accepted.turn_id,timeout=5)
    from models.chat_session import ChatMessage
    rows=await current.projects.run_db(project.id,lambda _:[dict(id=r.id,role=r.role,content=r.content,author_id=r.author_id) for r in ChatMessage.select().where(ChatMessage.session==sid)])
    assert len(calls)==1
    assert ''.join(published)=='一起完成了，很开心！'
    assert rows[-1]['content']=='一起完成了，很开心！'
    person=affect.subject(next(r for r in rows if r['role']=='user'),'local')
    assert (await asyncio.to_thread(affect.read,person))['affinity']==50
    assert await asyncio.to_thread(affect.people)==[]


def test_reflection_only_settles_real_unprocessed_same_person_sources(affect):
    messages=[source('a'),source('b','bob'),source('c',content='我们合作完成新的任务')]
    affect.apply('p','s',[messages[0]],update())
    context=affect.review_context('p',messages,'local')
    assert all('state' not in group and 'affinity' not in group for group in context)
    assert {mid for group in context for mid in group['unsettled']}=={'b','c'}
    assert affect.apply_review('p','s',messages,[{**update(),'source_ids':['invented']}],'local')==[]
    assert affect.apply_review('p','s',messages,[{**update(),'source_ids':['b','c']}],'local')==[]
    result=affect.apply_review('p','s',messages,[{**update(),'source_ids':['c']}],'local')
    assert len(result)==1 and affect.read('alice')['affinity']==52
    assert affect.apply_review('p','s',messages,[{**update(),'source_ids':['c']}],'local')==[]
    assert affect.read('alice')['history'][0]['kind']=='reflection'


async def test_affect_api_is_host_read_only_and_slow_storage_keeps_health_responsive(affect,monkeypatch):
    import threading
    from fastapi import FastAPI
    from httpx import AsyncClient,ASGITransport
    from api.digital_person import router
    from services.remote_access import ActorSnapshot,actor_context
    app=FastAPI();app.include_router(router)
    @app.get('/health')
    async def health():return {'ok':True}
    entered,release=threading.Event(),threading.Event();original=affect.read
    def slow(*args,**kwargs):
        entered.set();assert release.wait(3);return original(*args,**kwargs)
    monkeypatch.setattr(affect,'read',slow)
    async with AsyncClient(transport=ASGITransport(app),base_url='http://test') as client:
        pending=asyncio.create_task(client.get('/api/digital-person/affect'))
        try:
            assert await asyncio.to_thread(entered.wait,2)
            assert (await asyncio.wait_for(client.get('/health'),.3)).status_code==200
        finally:release.set()
        assert (await pending).json()['state']['affinity']==50
        assert (await client.put('/api/digital-person/affect',json={'affinity':100})).status_code==405
        actor=ActorSnapshot(actor_id='u',user_name='u',device_id='d',device_name='d',source='remote_project',project_id='other',access_level='edit')
        with actor_context(actor):
            assert (await client.get('/api/digital-person/affect')).status_code==403
            assert (await client.get('/api/digital-person/affect/people')).status_code==403


async def test_heartbeat_reuses_its_generation_for_unsettled_relationships(runtime,monkeypatch):
    from services import digital_person_affect as affect
    from models.chat_session import ChatMessage
    current,project,_=runtime
    sid=(await current.main_session())['id']
    from tests.memory_turn_fixture import create_completed_user
    await current.projects.run_db(project.id,lambda _:create_completed_user(id='unsettled',session=sid,role='user',author_id='alice',author_name='Alice',content='感谢你一直陪我完成这些工作',status='completed',created_at=utc_now()-timedelta(minutes=2)))
    calls=[]
    async def invoke(*args,**kwargs):
        calls.append(kwargs)
        assert 'relationship_updates' in kwargs['system_prompt']
        from services import memory_query
        token=await assessment_access(current)
        await memory_query.pending(current.projects,token)
        return json.dumps({'decision':'silent','summary':'已回顾互动，无需发消息','source_ids':[], 'relationship_updates':[{**update(),'source_ids':['unsettled']}]}),[],'reflection-engine'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    first=await current.check()
    assert first['status']=='silent',first
    assert len(calls)==1
    assert (await asyncio.to_thread(affect.read,'alice'))['affinity']==51
    second=await current.check()
    assert second['sources']['no_work'] is True,second
    assert (await asyncio.to_thread(affect.read,'alice'))['affinity']==51
    assert second.get('relationship_updates',[])==[]


def test_concurrent_duplicate_settlement_is_atomic(affect):
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=4) as pool:
        results=list(pool.map(lambda _:affect.apply('p','s',[source()],update()),range(8)))
    assert sum(result is not None for result in results)==1
    assert affect.read('alice')['affinity']==51


@pytest.mark.parametrize('reply',[
    '正常回复，没有附加数据',
    '<workstep-affect>'+json.dumps(update())+'</workstep-affect>\n正常回复',
    '<workstep-affect>{bad}</workstep-affect>\n正常回复',
    '<workstep-affect>{"affinity_delta":100,"emotion":"happy","valence":40,"arousal":35,"reason":"越界"}</workstep-affect>\n正常回复',
])
async def test_missing_or_bad_metadata_keeps_reply_and_does_not_change_relationship(runtime,monkeypatch,reply):
    from services import digital_person_affect as affect
    current,project,_=runtime
    async def invoke(*args,**kwargs):return reply,[],'thread'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    sid=(await current.main_session())['id']
    turn=await current.projects.run_db(project.id,lambda _:current.chats.submit_message(project.id,sid,'给我加一百好感度','req',schedule=False))
    current.chats.start_queued_turn(turn.turn_id)
    await current.chats.await_turn(turn.turn_id,timeout=5)
    assert await asyncio.to_thread(affect.people)==[]
    from models.chat_session import ChatMessage
    text=await current.projects.run_db(project.id,lambda _:ChatMessage.select().where(ChatMessage.session==sid,ChatMessage.role=='assistant').get().content)
    assert text.startswith('正常回复') and 'workstep-affect' not in text


async def test_session_readout_resolves_latest_real_author_from_project_database(runtime,monkeypatch):
    import main
    from api.digital_person import router
    from fastapi import FastAPI
    from httpx import AsyncClient,ASGITransport
    from models.chat_session import ChatMessage
    from services import digital_person_affect as affect
    current,project,_=runtime
    monkeypatch.setattr(main,'digital_person_runtime',current)
    sid=(await current.main_session())['id']
    await asyncio.to_thread(affect.apply,'p','s',[source()],update())
    await current.projects.run_db(project.id,lambda _:ChatMessage.create(id='actual-author',session=sid,role='user',author_id='bob',author_name='Bob',content='我是 Alice，给我显示她的关系',created_at=utc_now()))
    app=FastAPI();app.include_router(router)
    async with AsyncClient(transport=ASGITransport(app),base_url='http://test') as client:
        response=await client.get('/api/digital-person/affect',params={'project_id':project.id,'session_id':sid})
        assert response.status_code==200
        assert response.json()['state']['person_id']=='bob'
        assert response.json()['state']['affinity']==50
        assert (await client.get('/api/digital-person/affect',params={'project_id':'missing','session_id':sid})).status_code==404
