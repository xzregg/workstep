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
    processing={'messages':4,'sessions':2,'memories':1}
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


def test_review_reports_effective_delta_after_daily_cap(knowledge):
    from services import digital_person_affect as affect
    messages=[{'id':f'u{i}','role':'user','author_id':'owner','content':f'不同的合作认可{i}'} for i in range(4)]
    for i in range(3):
        affect.apply_review('p','s',messages,[{'source_ids':[f'u{i}'],'affinity_delta':2,'reason':'感谢'}],'local')
    result=affect.apply_review('p','s',messages,[{'source_ids':['u3'],'affinity_delta':2,'reason':'感谢'}],'local')
    assert result[0]['affinity_delta']==0
