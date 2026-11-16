"""Behavioral acceptance for incremental reflection; no paid model calls."""
import asyncio
import pytest
from models.chat_session import ChatMessage, ChatSession
from models.fields import utc_now
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime

async def seed(runtime, *, archived=False):
    current, project, _ = runtime
    sid = (await current.main_session())['id']
    def write(_):
        ChatMessage.create(id='evidence',session=sid,role='user',status='completed',content='这次不要测试，不是永久偏好',created_at=utc_now())
        if archived:
            ChatSession.update(archived=True).where(ChatSession.id==sid).execute()
    await current.projects.run_db(project.id,write)
    return sid

@pytest.mark.parametrize('archived',[False,True])
async def test_success_is_persistent_and_empty_work_never_calls_model(runtime,monkeypatch,archived):
    current,project,_=runtime
    await seed(runtime,archived=archived)
    calls=[]
    async def decide(ctx):
        calls.append(ctx)
        return {'decision':'silent','summary':'已解读，无值得保留的经验','source_ids':[]}
    monkeypatch.setattr(current,'_decide',decide)
    assert (await current.check())['status']=='silent'
    assert (await current.check())['sources']['no_work'] is True
    assert len(calls)==1
    assert calls[0]['conversation'][0]['id']=='evidence'
    # A fresh runtime must use the same persisted completion receipt.
    from services.digital_person_runtime import DigitalPersonRuntime
    fresh=DigitalPersonRuntime(current.projects,current.chats,None,current.bus)
    monkeypatch.setattr(fresh,'_decide',decide)
    await fresh.check()
    assert len(calls)==1

async def test_invalid_output_retries_but_new_content_version_is_processed(runtime,monkeypatch):
    current,project,_=runtime
    await seed(runtime)
    calls=[]
    async def decide(ctx):
        calls.append(ctx)
        return {'decision':'notify' if len(calls)==1 else 'silent','summary':'结果','source_ids':['fabricated'] if len(calls)==1 else []}
    monkeypatch.setattr(current,'_decide',decide)
    assert (await current.check())['status']=='failed'
    assert (await current.check())['status']=='silent'
    assert len(calls)==2
    await current.projects.run_db(project.id,lambda _:ChatMessage.update(content='用户明确纠正了之前的偏好').where(ChatMessage.id=='evidence').execute())
    # Normal save hooks refresh the index; exercise the same capture path after edit.
    from services.digital_person_memory import capture_message
    await current.projects.run_db(project.id,lambda _:capture_message(ChatMessage.get_by_id('evidence'),'local'))
    await current.check()
    assert len(calls)==3

async def test_archived_source_is_reflected_without_notification_or_unarchive(runtime,monkeypatch):
    current,project,_=runtime
    sid=await seed(runtime,archived=True)
    async def decide(ctx):
        return {'decision':'notify','summary':'旧结果','source_ids':['evidence']}
    async def notify(*args):
        pytest.fail('archived history is internal reflection only')
    monkeypatch.setattr(current,'_decide',decide)
    monkeypatch.setattr(current,'_notify',notify)
    assert (await current.check())['status']=='silent'
    assert await current.projects.run_db(project.id,lambda _:ChatSession.get_by_id(sid).archived)
    await current.check()

async def test_slow_reflection_receipts_do_not_block_loop(runtime,monkeypatch):
    current,_,_=runtime
    await seed(runtime)
    from services import digital_person_assessment as assessment
    import time
    original=assessment.pending
    called=[]
    def slow(*args,**kwargs):
        called.append(True)
        time.sleep(.08)
        return original(*args,**kwargs)
    monkeypatch.setattr(assessment,'pending',slow)
    async def decide(ctx):
        return {'decision':'silent','summary':'无新经验','source_ids':[]}
    monkeypatch.setattr(current,'_decide',decide)
    ticks=[]
    async def canary():
        for _ in range(15):
            ticks.append(time.monotonic())
            await asyncio.sleep(.01)
    await asyncio.gather(current.check(),canary())
    assert called
    assert max(b-a for a,b in zip(ticks,ticks[1:]))<.06


async def test_large_history_drains_once_in_bounded_batches(runtime,monkeypatch):
    current,project,_=runtime
    sid=await seed(runtime,archived=True)
    await current.projects.run_db(project.id,lambda _:[ChatMessage.create(
        id=f'old-{i:03}',session=sid,role='assistant' if i%2 else 'user',status='completed',
        content=f'历史独立交流{i}',created_at=utc_now()) for i in range(45)])
    seen=[]
    async def decide(ctx):
        ids=[m['id'] for m in ctx['conversation']]
        assert len(ctx['reflection_batch'])<=20
        assert not set(ids).intersection(seen)
        seen.extend(ids)
        return {'decision':'silent','summary':'已检查，可不生成经验','source_ids':[]}
    monkeypatch.setattr(current,'_decide',decide)
    for _ in range(6):await current.check()
    assert len(seen)==46
    await current.projects.run_db(project.id,lambda _:ChatSession.update(archived=False).where(ChatSession.id==sid).execute())
    await current.check()
    assert len(seen)==46


async def test_social_disabled_still_processes_internal_state(runtime,monkeypatch):
    current,_,store=runtime
    await seed(runtime)
    store.set('digital_person',{'enabled':True,'proactive_enabled':False})
    calls=[]
    async def decide(ctx):
        calls.append(ctx)
        return {'decision':'notify','kind':'social','summary':'不对外投递','source_ids':['evidence'],'mood':'curious'}
    monkeypatch.setattr(current,'_decide',decide)
    first=await current.check(manual=False)
    assert first['status']=='silent' and first['deliveries']==[]
    assert (await current.state())['companions']['local']['mood']=='curious'
    await current.check(manual=False)
    assert len(calls)==1


async def test_failed_delivery_does_not_reprocess_successful_reflection(runtime,monkeypatch):
    current,_,_=runtime
    await seed(runtime)
    calls=[]
    async def decide(ctx):
        calls.append(ctx)
        return {'decision':'notify','kind':'work','summary':'结果','source_ids':['evidence']}
    async def notify(*args):return [{'kind':'local','status':'failed','error':'offline'}]
    monkeypatch.setattr(current,'_decide',decide)
    monkeypatch.setattr(current,'_notify',notify)
    assert (await current.check())['status']=='delivery_failed'
    assert (await current.check())['sources']['no_work'] is True
    assert len(calls)==1


async def test_source_change_during_model_run_is_not_marked_processed(runtime,monkeypatch):
    current,project,_=runtime
    await seed(runtime)
    calls=[]
    async def decide(ctx):
        calls.append(ctx)
        if len(calls)==1:
            from services.digital_person_memory import capture_message
            def edit(_):
                ChatMessage.update(content='模型运行期间的新修正').where(ChatMessage.id=='evidence').execute()
                capture_message(ChatMessage.get_by_id('evidence'),'local')
            await current.projects.run_db(project.id,edit)
        return {'decision':'silent','summary':'已看过','source_ids':[]}
    monkeypatch.setattr(current,'_decide',decide)
    assert (await current.check())['status']=='failed'
    await current.check()
    assert len(calls)==2
    assert '新修正' in calls[1]['conversation'][0]['content']


async def test_internal_reflection_cadence_is_independent_of_delegation_poll(runtime,monkeypatch):
    from datetime import timedelta
    current,_,store=runtime
    store.set('digital_person',{'enabled':True,'proactive_enabled':False,'proactive_interval_minutes':30})
    now=utc_now()
    polls=[];checks=[]
    async def follow(profile):polls.append(True)
    async def check(**kwargs):checks.append(True)
    monkeypatch.setattr(current,'follow_delegations',follow)
    monkeypatch.setattr(current,'check',check)
    await current._tick(now)
    await current._tick(now+timedelta(minutes=1))
    assert len(polls)==2 and checks==[]
    await current._tick(now+timedelta(minutes=30))
    assert checks==[True]


async def test_delivered_output_never_becomes_knowledge_extraction_evidence(runtime):
    from services import digital_person_memory as memory, memory_knowledge as knowledge
    current,project,_=runtime
    sid=(await current.main_session())['id']
    await current._deliver_local(sid,'我推测用户喜欢某事','synthetic-run')
    await memory.sync_projects(current.projects)
    from services import digital_person_memory_index as index
    assert await asyncio.to_thread(index.candidates,'local')==[]
    assert await asyncio.to_thread(knowledge._claim,[project.id],8)==[]



def test_model_projection_preserves_repeated_messages_and_discards_cross_project_assistant_reports():
    from services.digital_person_reflection import model_context
    text='同一段真实用户内容'
    context={'messages':[{'id':'u1','content':text}],
        'conversation':[{'id':'u1','role':'user','author_id':'owner','content':text,'session_id':'s'},
                        {'id':'u2','role':'user','author_id':'owner','content':text,'session_id':'s'}],
        'memory':[{'id':'memory:1','project_id':'home','source_message_id':'u1','role':'user','content':text},
                  {'id':'memory:2','project_id':'other','source_message_id':'a','role':'assistant','content':'关于主动思考系统的旧解释'},
                  {'id':'memory:3','project_id':'other','source_message_id':'u3','role':'user','content':'真实偏好依据'}],
        'reflection_batch':[{'internal':'receipt'}], 'origin_session_id':'s'}
    result=model_context(context,'home')
    import json
    encoded=json.dumps(result,ensure_ascii=False)
    assert encoded.count(text)==2
    assert 'messages' not in result and 'reflection_batch' not in result
    assert [m['id'] for m in result['conversation']]==['u1','u2']
    assert [m['id'] for m in result['memory']]==['memory:3']
    assert context['conversation'][0]['session_id']=='s'
    assert len(context['conversation'])==2


def test_model_projection_never_merges_different_speakers():
    from services.digital_person_reflection import model_context
    ctx={'conversation':[{'id':'a','role':'user','author_id':'alice','content':'一样'},
                         {'id':'b','role':'user','author_id':'bob','content':'一样'}]}
    assert len(model_context(ctx,'home')['conversation'])==2


def test_model_input_omits_runtime_bookkeeping_and_old_notification_text():
    import json
    from services.digital_person_reflection import model_context
    context={'conversation':[], 'memory':[], 'indexed':100, 'busy':False, 'archived_source':False,
             'previous_notifications':[{'summary':'OLD-UNRELATED-NOTIFICATION-TEXT','source_ids':['old-source']}],
             'origin_session_id':'source','clock':'now'}
    result=model_context(context,'home')
    assert 'OLD-UNRELATED-NOTIFICATION-TEXT' not in json.dumps(result)
    assert not {'indexed','busy','archived_source'}.intersection(result)
    assert result['previous_notifications']==[{'source_ids':['old-source']}]


async def test_legacy_notice_with_delivery_receipt_cannot_reenter_evidence(runtime):
    import uuid
    from services import digital_person_memory as memory, digital_person_memory_index as index
    current,project,_=runtime
    sid=(await current.main_session())['id']
    mid=str(uuid.uuid5(uuid.NAMESPACE_URL,'old-run'+sid))
    def seed_notice(_):
        row=ChatMessage.create(id=mid,session=sid,role='assistant',status='completed',content='旧版自动通知，不是新经历',created_at=utc_now())
        memory.capture_message(row,'local')
    await current.projects.run_db(project.id,seed_notice)
    await current.mutate(lambda s:s['runs'].append({'id':'old-run','status':'notified','deliveries':[{'kind':'local','session_id':sid,'status':'delivered'}]}))
    context=await current._collect()
    assert context['no_work'] is True
    with index.connect() as db:
        assert db.execute('SELECT 1 FROM memories WHERE source_message_id=?',(mid,)).fetchone() is None
    assert await current.projects.run_db(project.id,lambda _:ChatMessage.get_by_id(mid).content)=='旧版自动通知，不是新经历'


async def test_invalid_notification_does_not_commit_reflection_receipts(runtime,monkeypatch):
    from services import digital_person_reflection as reflection
    current,project,_=runtime
    await seed(runtime)
    original=current._collect
    async def collect():
        ctx=await original()
        ctx['delegations']=[{'id':'running-work','status':'running'}]
        return ctx
    async def decide(ctx):return {'decision':'notify','kind':'work','summary':'尚未完成','source_ids':['running-work']}
    monkeypatch.setattr(current,'_collect',collect)
    monkeypatch.setattr(current,'_decide',decide)
    assert (await current.check())['status']=='failed'
    pending=await asyncio.to_thread(reflection.pending,project.id)
    assert [row['source_message_id'] for row in pending]==['evidence']
