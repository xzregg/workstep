"""Behavioral acceptance for incremental reflection; no paid model calls."""
import asyncio
import pytest
from models.chat_session import ChatMessage, ChatSession
from models.fields import utc_now
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime
from tests.memory_turn_fixture import assessment_access, create_completed_user

async def seed(runtime, *, archived=False):
    current, project, _ = runtime
    sid = (await current.main_session())['id']
    def write(_):
        ChatMessage.create(id='evidence',session=sid,role='user',status='completed',content='这次不要测试，不是永久偏好',created_at=utc_now())
        if archived:
            ChatSession.update(archived=True).where(ChatSession.id==sid).execute()
    await current.projects.run_db(project.id,write)
    return sid

@pytest.mark.parametrize('archive_during_thinking', [False, True])
async def test_archived_source_is_reflected_without_notification_or_unarchive(runtime,monkeypatch,archive_during_thinking):
    current,project,_=runtime
    from services.digital_person_reflection import model_context
    from services import digital_person_memory_index as index
    sid=(await current.main_session())['id']
    def prepare(_):
        create_completed_user(id='evidence',session=sid,role='user',status='completed',
                              content='帮我整理一份报告，还没开始做。',created_at=utc_now())
        if not archive_during_thinking:
            ChatSession.update(archived=True).where(ChatSession.id==sid).execute()
    await current.projects.run_db(project.id,prepare)
    async def decide(ctx):
        await ctx['_load']()
        assert model_context(ctx,project.id)['archived_source'] is (not archive_during_thinking)
        if archive_during_thinking:
            await current.projects.run_db(project.id,lambda _:ChatSession.update(archived=True).where(ChatSession.id==sid).execute())
        return {'decision':'notify','summary':'请继续整理报告','source_ids':['evidence'],
                'memories':[{'summary':'用户委托整理报告，尚未完成'+('。' if archive_during_thinking else '，会话已归档。'),
                             'kind':'event','outcome':'planned','source_ids':ctx['conversation'][0]['memory_ids']}]}
    async def notify(*args):
        pytest.fail('archived history is internal reflection only')
    monkeypatch.setattr(current,'_decide',decide)
    monkeypatch.setattr(current,'_notify',notify)
    result=await current.check()
    assert result['status']=='silent',result
    if archive_during_thinking:
        assert result['summary']=='Archived source processed internally; no notification sent.'
    assert result['memory_processing']['knowledge']['created']==1
    with index.connect() as db:
        row=db.execute('SELECT summary,outcome FROM memory_knowledge').fetchone()
        assert '尚未完成' in row['summary'] and row['outcome']=='planned'
    assert await current.projects.run_db(project.id,lambda _:ChatSession.get_by_id(sid).archived)
    await current.check()

async def test_social_disabled_still_processes_internal_state(runtime,monkeypatch):
    current,project,store=runtime
    sid=(await current.main_session())['id']
    await current.projects.run_db(project.id,lambda _:create_completed_user(
        id='evidence',session=sid,role='user',status='completed',
        content='这次不要测试，不是永久偏好',created_at=utc_now()))
    store.set('digital_person',{'enabled':True,'proactive_enabled':False})
    calls=[]
    async def invoke(*args,**kwargs):
        from services import memory_query
        access=await assessment_access(current)
        payload=await memory_query.pending(current.projects,access)
        calls.append(payload)
        return '{"decision":"notify","kind":"social","summary":"不对外投递","source_ids":["evidence"]}',[],'native'
    async def notify(*args):
        pytest.fail('disabled proactive contact must not deliver a social notice')
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    monkeypatch.setattr(current,'_notify',notify)
    first=await current.check(manual=False)
    assert first['status']=='silent' and first['deliveries']==[],first
    assert first['memory_processing']['knowledge']['processed']==2
    assert (await current.check(manual=False))['sources']['no_work'] is True
    assert len(calls)==1


async def test_delivered_output_never_becomes_knowledge_extraction_evidence(runtime):
    from services import digital_person_memory as memory
    current,project,_=runtime
    sid=(await current.main_session())['id']
    await current._deliver_local(sid,'我推测用户喜欢某事','synthetic-run')
    await memory.sync_projects(current.projects)
    from services import digital_person_memory_index as index
    assert await asyncio.to_thread(index.candidates,'local')==[]
    from services import digital_person_assessment as assessment
    assert await asyncio.to_thread(assessment.pending,[project.id],baseline=utc_now().isoformat())==[]



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
    assert not {'indexed','busy'}.intersection(result)
    assert result['archived_source'] is False
    assert result['previous_notifications']==[{'source_ids':['old-source']}]


def test_grouped_model_input_keeps_archive_status_per_source_conversation():
    from services.digital_person_assessment import instruction
    from services.digital_person import DigitalPersonProfile
    from services.digital_person_reflection import model_context
    result=model_context({'origin_project_id':'p','_groups':[
        {'origin_project_id':'p','origin_session_id':'archived','archived_source':True},
        {'origin_project_id':'p','origin_session_id':'active','archived_source':False}]},'p')
    assert [(g['session_id'],g['archived_source']) for g in result['conversations']]==[
        ('archived',True),('active',False)]
    text=instruction(DigitalPersonProfile())
    assert 'For archived_source=true' in text
    assert 'Archiving is not task completion' in text
    assert 'when the user explicitly brings it up later' in text


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
