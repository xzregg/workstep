from datetime import timedelta
import pytest

from models.fields import utc_now
from tests.memory_turn_fixture import create_completed_user
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime
from tests.test_memory_knowledge import knowledge


@pytest.mark.parametrize('notify',[False,True])
async def test_success_history_reports_real_processing_and_signed_affinity_changes(runtime,monkeypatch,notify):
    current,project,_=runtime
    now=utc_now()-timedelta(minutes=2)
    await current.mutate(lambda s:s.update(assessment_live_since=(now-timedelta(days=1)).isoformat()))
    def seed(_):
        for i,text in enumerate(['这个结果帮上忙了，谢谢。','这次沟通让我感到不被尊重。']):
            sid=current.chats.create_session(project.id)['id']
            create_completed_user(id=f'user-{i}',session=sid,role='user',content=text,
                                  author_id='owner',created_at=now+timedelta(seconds=i))
    await current.projects.run_db(project.id,seed)
    async def decide(context):
        await context['_load']()
        source=next(m for m in context['conversation'] if m['id']=='user-0')['memory_ids'][0]
        return {'decision':'notify' if notify else 'silent','summary':'模型内部分析正文','source_ids':['user-0'] if notify else [],
                'memories':[{'kind':'event','outcome':'stated','summary':'用户认可这次协作结果','source_ids':[source]}],
                'relationship_updates':[{'source_ids':['user-0'],'affinity_delta':2,'reason':'明确的合作认可'},
                                        {'source_ids':['user-1'],'affinity_delta':-1,'reason':'明确表达不被尊重'}]}
    monkeypatch.setattr(current,'_decide',decide)
    sent=[]
    async def deliver(text,*args):
        sent.append(text)
        return [{'status':'delivered'}]
    monkeypatch.setattr(current,'_notify',deliver)
    run=await current.check()
    assert run['status']==('notified' if notify else 'silent'),run
    records=await current.activity_records()
    processing={'messages':4,'sessions':2,'memories':1,'changes':{'added':{'event':1},'updated':{}}}
    assert run['processing'] == records['runs'][0]['processing'] == processing
    assert not records['runs'][0]['summary']
    assert records['runs'][0]['outcome']['affinity_increased'] == 2
    assert records['runs'][0]['outcome']['affinity_decreased'] == 1
    detail=await current.run_detail(run['id'])
    assert detail['processing'] == processing
    assert ('模型内部分析正文' in detail['summary']) is not notify
    assert detail['notification_message'] == ('模型内部分析正文' if notify else None)
    assert 'notification_message' not in records['runs'][0]
    assert run['summary']=='模型内部分析正文'
    assert sent==(['模型内部分析正文'] if notify else [])
    from services import digital_person_memory_index as index
    with index.connect() as db:
        db.execute('DELETE FROM memory_knowledge')
    # Historical counts describe the committed run, not today's surviving rows.
    assert (await current.run_detail(run['id']))['processing']==processing


def test_reflection_change_counts_use_actual_inserts_and_preserve_replacement_semantics(knowledge):
    from tests.test_memory_knowledge import seed,payload
    from services import digital_person_memory_index as index
    old=seed()
    knowledge.store_extraction(payload(old),index.candidates('local'))
    new=seed('以后晚上工作；新增独立事实和事件。')
    version=knowledge.read_record('local',['p'],'knowledge:1')['version']
    items=[dict(summary='用户以后晚上工作',kind='preference',outcome='stated',source_ids=[f'memory:{new}'],supersedes=['knowledge:1'])]
    for kind in ('fact','event','experience'):
        item=dict(summary=kind+'独立内容',kind=kind,outcome='reported',source_ids=[f'memory:{new}'])
        if kind=='experience':item['experience']=dict(situation='时钟偏差造成签名失败',action='同步时钟',result='签名恢复')
        items.append(item)
    # A repeated candidate is accepted but creates no new knowledge or count.
    items.append(dict(items[1]))
    result=knowledge.store_extraction({'memories':items},index.candidates('local'),{'knowledge:1':version},report=True,strict=True,reflection_run_id='typed')
    assert result['created']==4
    assert result['changes']=={'added':{'fact':1,'event':1,'experience':1},'updated':{'preference':1}}
    from services.memory_atlas import _reflection_additions
    preview=_reflection_additions(['p'],'typed')
    assert [(item['kind'],item['operation']) for item in preview['items']]==[
        ('preference','updated'),('fact','added'),('event','added'),('experience','added')]
    with index.connect() as db:
        assert db.execute('SELECT state FROM memory_knowledge WHERE id=1').fetchone()[0]=='superseded'
        assert db.execute('SELECT count(*) FROM memory_reflection_additions WHERE run_id=?',('typed',)).fetchone()[0]==4
        db.execute("UPDATE memory_knowledge SET state='conflict' WHERE id=2")
    # A later disagreement must not rewrite the original run's operation.
    assert _reflection_additions(['p'],'typed')['items'][0]['operation']=='updated'
    another=seed('对工作时间存在未解决的分歧')
    version=knowledge.read_record('local',['p'],'knowledge:2')['version']
    conflict=payload(another,supersedes=['knowledge:2'],conflict=True)
    conflict['memories'][0]['summary']='工作时间尚有分歧'
    result=knowledge.store_extraction(conflict,index.candidates('local'),{'knowledge:2':version},report=True,strict=True,reflection_run_id='conflict')
    assert result['changes']=={'added':{'preference':1},'updated':{}}
    assert _reflection_additions(['p'],'conflict')['items'][0]['operation']=='added'


def test_review_reports_effective_delta_after_daily_cap(knowledge):
    from services import digital_person_affect as affect
    messages=[{'id':f'u{i}','role':'user','author_id':'owner','content':f'不同的合作认可{i}'} for i in range(4)]
    for i in range(3):
        affect.apply_review('p','s',messages,[{'source_ids':[f'u{i}'],'affinity_delta':2,'reason':'感谢'}],'local')
    result=affect.apply_review('p','s',messages,[{'source_ids':['u3'],'affinity_delta':2,'reason':'感谢'}],'local')
    assert result[0]['affinity_delta']==0
