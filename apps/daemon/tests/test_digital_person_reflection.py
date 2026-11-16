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
