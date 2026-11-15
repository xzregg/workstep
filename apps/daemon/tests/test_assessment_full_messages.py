from tests.memory_turn_fixture import create_completed_user
from datetime import timedelta
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime


async def test_pending_delivers_whole_long_message_not_twenty_fragments(runtime):
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    from services.digital_person_reflection import model_context
    current, project, _=runtime
    sid=(await current.main_session())['id']
    body='完整正文段落。'*6000+'末尾不可遗漏'
    await current.projects.run_db(project.id,lambda _:create_completed_user(
        id='whole',session=sid,role='user',content=body,created_at=utc_now()-timedelta(minutes=2)))
    context=await current._collect()
    payload=model_context(context,project.id)
    assert payload['conversation'][0]['content']==body
    assert 'needs_read' not in payload['conversation'][0]
    assert context['_read_requirements']==[]
    assert len(context['reflection_batch'])==2


async def test_old_due_thought_does_not_trigger_model(runtime,monkeypatch):
    from models.fields import utc_now
    current, _, _=runtime
    now=utc_now()
    await current.mutate(lambda s:s.update(companions={'local':{'thought':{
        'content':'旧念头','status':'pending','source_ids':['old'],
        'not_before':(now-timedelta(hours=1)).isoformat(),
        'expires_at':(now+timedelta(hours=1)).isoformat()}}}))
    async def forbidden(*args):
        raise AssertionError('old thought must not launch a generation')
    monkeypatch.setattr(current,'_decide',forbidden)
    result=await current.check()
    assert result['status']=='silent' and result['sources']['no_work']


async def test_unrequested_thought_is_not_persisted(runtime,monkeypatch):
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    current, project, _=runtime
    sid=(await current.main_session())['id']
    await current.mutate(lambda s:s.update(assessment_live_since=(utc_now()-timedelta(days=1)).isoformat()))
    await current.projects.run_db(project.id,lambda _:create_completed_user(
        id='new',session=sid,role='user',content='最近这次合作很好',created_at=utc_now()-timedelta(minutes=2)))
    async def decide(ctx):
        if ctx.get('_load'): await ctx['_load']()
        assert 'thought' not in ctx['companion']
        assert 'mood' not in ctx['companion']
        assert ctx['companion']['contact_timing']['minimum_interval_minutes'] == 10
        return {'decision':'silent','summary':'本轮已整理','source_ids':[],
                'mood':'happy',
                'relationship_updates':[{'source_ids':['new'],'affinity_delta':2,'reason':'合作建立信任'}],
                'thought':{'content':'不该保存','source_ids':['new'],'after_minutes':1}}
    monkeypatch.setattr(current,'_decide',decide)
    result=await current.check()
    assert result['status']=='silent'
    assert not (await current.state())['companions']['local'].get('thought')

    assert not (await current.state())['companions']['local'].get('mood')
    assert result['relationship_updates'][0]['affinity']==52


async def test_pending_user_action_reminder_bypasses_social_contact_gate(runtime,monkeypatch):
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    current, project, _=runtime
    sid=(await current.main_session())['id']
    now=utc_now()
    await current.mutate(lambda s:s.update(assessment_live_since=(now-timedelta(days=1)).isoformat(),
        companions={'local':{'contacts':[{'at':(now-timedelta(minutes=1)).isoformat()}]}}))
    def seed(_):
        from tests.memory_turn_fixture import create_completed_reply
        for i,(role,body) in enumerate([('user','继续部署'),('assistant','部署尚未完成，需要你先在设备上确认登录')]):
            create=ChatMessage.create if role=='user' else create_completed_reply
            create(id=f'waiting-{i}',session=sid,role=role,content=body,
                status='completed',created_at=now-timedelta(minutes=3-i))
    await current.projects.run_db(project.id,seed)
    async def decide(ctx):
        if ctx.get('_load'): await ctx['_load']()
        assert not ctx['companion']['contact_policy']['allowed']
        assert len(ctx['conversation'])==2
        return {'decision':'notify','kind':'work','summary':'部署还差设备登录确认，请先在设备上完成登录。',
                'source_ids':['waiting-0','waiting-1']}
    monkeypatch.setattr(current,'_decide',decide)
    monkeypatch.setattr('services.digital_person_channels.get_bindings',lambda:[])
    result=await current.check()
    assert result['status']=='notified',result
    again=await current.check()
    assert again['sources']['no_work']
