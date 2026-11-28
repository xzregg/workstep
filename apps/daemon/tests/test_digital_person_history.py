import json
import uuid
from datetime import timedelta
from types import SimpleNamespace

from models.chat_session import ChatMessage
from models.fields import utc_now
from tests.test_digital_person_runtime import chat_module, runtime


async def test_channel_receipts_supply_missing_notice_history_and_acknowledge_only_on_success(runtime, monkeypatch):
    from agent_assistants.channel_chat import ChannelChatModule
    from models.chat_session import ChatSession
    from services.digital_person_channels import peer_id

    service, home, store = runtime
    await service.main_session()
    module = ChannelChatModule(service.bus, service.projects, register=False)
    sid = await service.projects.run_db(home.id, lambda _: module.create_session(home.id, title='channel')['id'])
    peer = {'bot_id': 'bot', 'conversation_type': 'single', 'conversation_id': 'user'}
    others = [{**peer, 'bot_id': 'other-bot'}, {**peer, 'conversation_type': 'group'},
              {**peer, 'conversation_id': 'other-user'}]
    store.set('channel_bots', {'sessions': {'bot:single:user': sid}})
    store.set('digital_person_channels', [peer, *others])
    monkeypatch.setattr('services.digital_person_channels.config_store', store)
    now = utc_now()
    runs = [
        {'id': 'delivered', 'summary': '真实 API 补验完成；浏览器验收尚未覆盖。',
         'notified_at': now.isoformat(), 'notification_sources': ['task'],
         'deliveries': [{'kind': 'channel', 'binding_id': peer_id(peer), 'status': 'delivered'}]},
        {'id': 'failed', 'summary': '发送失败的通知', 'created_at': now.isoformat(),
         'deliveries': [{'kind': 'channel', 'binding_id': peer_id(peer), 'status': 'failed'}]},
        {'id': 'old', 'summary': '重置前通知', 'created_at': (now - timedelta(days=1)).isoformat(),
         'deliveries': [{'kind': 'channel', 'binding_id': peer_id(peer), 'status': 'delivered'}]},
        *[{'id': f'foreign-{index}', 'summary': '其他渠道的通知', 'created_at': now.isoformat(),
           'deliveries': [{'kind': 'channel', 'binding_id': peer_id(other), 'status': 'delivered'}]}
          for index, other in enumerate(others)],
    ]
    await service.mutate(lambda state: (state['runs'].extend(runs), state['delegations'].append({
            'id': 'task', 'origin_session_id': sid, 'project_id': 'execution-project',
        'session_id': 'execution-session', 'message_id': 'execution-result', 'notification_run_id': 'delivered'})))
    await service.projects.run_db(home.id, lambda _: ChatSession.update(
        context_reset_at=now - timedelta(hours=1)).where(ChatSession.id == sid).execute())
    session = SimpleNamespace(project_id=home.id, session_id=sid, engine='codex_sdk',
                              resolved_session_id='thread', extra={})
    async def load():
        return await service.projects.run_db(home.id, lambda _: module._load_digital_person_context(session))
    context = await load()
    notice, = context['pending']
    assert notice['content'] == runs[0]['summary']
    assert notice['sources'][0]['message_id'] == 'execution-result'
    assert notice['session_id'] == sid
    session.extra['digital_person_context'] = context
    monkeypatch.setattr(module, '_digital_person_prompt_parts', lambda _: {'identity': 'identity'})
    monkeypatch.setattr(module, '_role_system_prompt', lambda _: '')
    monkeypatch.setattr(module, 'get_system_prompt', lambda _: '')
    monkeypatch.setattr(module, '_turn_source_prompt_parts', lambda _: {})
    prompt = module._chat_system_prompt(session)
    assert '<conversation_notifications>' in prompt
    assert runs[0]['summary'] in prompt
    assert 'delegation_id=task' in prompt
    assert 'project_id=' not in prompt and 'session_id=' not in prompt and 'message_id=' not in prompt
    assert '发送失败' not in prompt and '其他渠道' not in prompt and '重置前' not in prompt
    # Merely constructing a prompt (or a failed turn) does not consume the receipt.
    assert (await load())['pending'] == context['pending']
    message = {}
    module._record_successful_turn_context(session, message)
    await service.projects.run_db(home.id, lambda _: ChatMessage.create(
        id='channel-ack', session=sid, role='assistant', status='succeeded', content='补验已完成。',
        context_json=json.dumps(message['context']), created_at=now + timedelta(seconds=1)))
    assert (await load())['pending'] == []
    # Rebuilding history still has the acknowledged notice available.
    assert (await load())['notices'] == context['notices']
    store.set('channel_bots', {'sessions': {'bot:single:user': 'another-session'}})
    assert (await load())['notices'] == []


async def test_channel_notice_binding_read_keeps_health_responsive(runtime, monkeypatch):
    import asyncio
    import threading
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from agent_assistants.channel_chat import ChannelChatModule

    service, home, _ = runtime
    module = ChannelChatModule(service.bus, service.projects, register=False)
    sid = await service.projects.run_db(home.id, lambda _: module.create_session(home.id, title='channel')['id'])
    session = SimpleNamespace(project_id=home.id, session_id=sid, engine='codex_sdk', resolved_session_id='thread')
    entered, release = threading.Event(), threading.Event()

    def slow_binding(_):
        entered.set()
        assert release.wait(3)
        return set()

    monkeypatch.setattr('services.digital_person_channels.binding_ids_for_session', slow_binding)
    app = FastAPI()

    @app.get('/health')
    async def health():
        return {'ok': True}

    loading = asyncio.create_task(service.projects.run_db(
        home.id, lambda _: module._load_digital_person_context(session)))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/health'), .3)).status_code == 200
    finally:
        release.set()
        await loading


async def test_proactive_history_contains_message_location_and_execution_reference(runtime,monkeypatch):
    service,home,store=runtime
    store.set('digital_person',{'enabled':True})
    origin=(await service.main_session())['id']
    run_id='reflection-notice'
    notice_id=str(uuid.uuid5(uuid.NAMESPACE_URL,run_id+origin))
    await service.mutate(lambda state:(state['delegations'].append({
        'id':'delegation','project_id':'execution-project','session_id':'execution-session',
        'message_id':'execution-result','origin_session_id':origin,
        'notification_run_id':run_id}),state['runs'].append({
            'id':run_id,'trigger':'delegation','notification_sources':['delegation'],
            'deliveries':[{'kind':'local','status':'delivered','session_id':origin}]})))
    await service.projects.run_db(home.id,lambda _:ChatMessage.create(
        id=notice_id,session=origin,role='assistant',status='completed',content='空表已补验通过。',
        context_json=json.dumps({'digital_person_proactive':True}),created_at=utc_now()))
    session=SimpleNamespace(project_id=home.id,session_id=origin,engine='codex_sdk',
                            resolved_session_id='thread',extra={})
    context=await service.projects.run_db(home.id,lambda _:service.chats._load_digital_person_context(session))
    session.extra['digital_person_context']=context
    monkeypatch.setattr(service.chats,'_digital_person_prompt_parts',lambda _: {'identity':'identity'})
    monkeypatch.setattr(service.chats,'_role_system_prompt',lambda _: '')
    monkeypatch.setattr(service.chats,'get_system_prompt',lambda _: '')
    prompt=service.chats._chat_system_prompt(session)
    history=context['pending']
    assert '"role":' not in prompt
    assert '"sources":' not in prompt
    assert '<conversation_notifications>\n' in context['notice_prompt']
    assert '<latest_notification>\n' in context['notice_prompt']
    assert context['notice_prompt'].endswith('</conversation_notifications>\n')
    assert '空表已补验通过。' in prompt
    assert 'delegation_id=delegation' in prompt
    assert 'project_id=' not in prompt and 'session_id=' not in prompt and 'message_id=' not in prompt
    assert len(history)==1
    assert history[0]['id']==notice_id
    assert history[0]['project_id']==home.id and history[0]['session_id']==origin
    assert history[0]['content']=='空表已补验通过。'
    assert history[0]['sources']==[{'delegation_id':'delegation','project_id':'execution-project',
                                   'session_id':'execution-session','message_id':'execution-result'}]
    assert history[0]['created_at']
    message={}
    service.chats._record_successful_turn_context(session,message)
    await service.projects.run_db(home.id,lambda _:ChatMessage.create(
        id='ack',session=origin,role='assistant',status='completed',content='收到',
        context_json=json.dumps(message['context']),created_at=utc_now()))
    current=await service.projects.run_db(home.id,lambda _:service.chats._load_digital_person_context(session))
    assert current['pending']==[]


async def test_old_proactive_notice_without_source_mapping_keeps_its_own_location(runtime):
    service,home,_=runtime
    origin=(await service.main_session())['id']
    other=await service.projects.run_db(home.id,lambda _:service.chats.create_session(home.id,title='other')['id'])
    def seed(_):
        for mid,sid in [('own',origin),('foreign',other)]:
            ChatMessage.create(id=mid,session=sid,role='assistant',status='completed',content=mid,
                context_json=json.dumps({'digital_person_proactive':True}),created_at=utc_now())
    await service.projects.run_db(home.id,seed)
    session=SimpleNamespace(project_id=home.id,session_id=origin,resolved_session_id='thread',engine='codex_sdk')
    context=await service.projects.run_db(home.id,lambda _:service.chats._load_digital_person_context(session))
    notice,=context['pending']
    assert notice['id']=='own'
    assert notice['project_id']==home.id and notice['session_id']==origin
    assert not notice.get('sources')


async def test_notice_prompt_only_exposes_actionable_source_identifiers(runtime, monkeypatch):
    service, home, _ = runtime
    module = service.chats
    session = SimpleNamespace(project_id=home.id, session_id='receiving-session', extra={})
    notice = {'id': 'internal-notice-id', 'content': '任务有进展', 'project_id': home.id,
              'session_id': 'receiving-session', 'created_at': '2026-11-24T08:00:00+08:00',
              'sources': [
                  {'delegation_id': 'task', 'project_id': 'task-project', 'session_id': 'task-session',
                   'message_id': 'result-a'},
                  {'delegation_id': 'task', 'project_id': 'task-project', 'session_id': 'task-session',
                   'message_id': 'result-b'},
                  {'project_id': 'other-project', 'session_id': 'other-session', 'message_id': 'raw-result'},
                  {'project_id': 'other-project', 'session_id': 'other-session'},
              ]}
    session.extra['digital_person_context'] = {'pending': [notice]}
    monkeypatch.setattr(module, '_digital_person_prompt_parts', lambda _: {})
    monkeypatch.setattr(module, '_role_system_prompt', lambda _: '')
    monkeypatch.setattr(module, 'get_system_prompt', lambda _: '')
    prompt = module._chat_system_prompt(session)
    assert prompt.count('delegation_id=task') == 1
    assert prompt.count('project_id=other-project session_id=other-session') == 1
    for unused in ('internal-notice-id', 'receiving-session', 'task-project', 'task-session',
                   'result-a', 'result-b', 'raw-result', 'message_id='):
        assert unused not in prompt
    # The rendering projection leaves receipts and source associations intact.
    assert notice['id'] == 'internal-notice-id'
    assert len(notice['sources']) == 4


async def test_latest_notice_is_explicit_and_keeps_its_own_open_target(runtime, monkeypatch):
    service, home, _ = runtime
    module = service.chats
    notices = [
        {'id': 'older', 'content': '排查委派对话弹窗缺少快捷按钮', 'created_at': '2026-11-25T01:50:00+00:00',
         'sources': [{'delegation_id': 'older-task'}]},
        {'id': 'latest', 'content': '自定义引擎包 tau 尚未安装和注册', 'created_at': '2026-11-25T04:10:00+00:00',
         'sources': [{'project_id': 'engine-project', 'session_id': 'engine-session'}]},
    ]
    session = SimpleNamespace(project_id=home.id, session_id='main', extra={'digital_person_context': {
        'pending': notices, 'delegation_list': '<delegations>\n- older-task: 排查快捷按钮\n</delegations>\n'}})
    monkeypatch.setattr(module, '_digital_person_prompt_parts', lambda _: {})
    monkeypatch.setattr(module, '_role_system_prompt', lambda _: '')
    monkeypatch.setattr(module, 'get_system_prompt', lambda _: '')
    import time
    if not hasattr(time, 'tzset'):
        import pytest
        pytest.skip('Timezone switching requires tzset')
    try:
        with monkeypatch.context() as zone:
            zone.setenv('TZ', 'Asia/Shanghai')
            time.tzset()
            prompt = module._chat_system_prompt(session)
    finally:
        time.tzset()
    assert prompt.count('<latest_notification>') == 1
    latest = prompt.split('<latest_notification>\n', 1)[1].split('\n</latest_notification>', 1)[0]
    assert '自定义引擎包 tau' in latest
    assert 'Source: project_id=engine-project session_id=engine-session' in latest
    assert 'older-task' not in latest
    assert '2026-11-25T12:10:00+08:00' in latest
    assert prompt.index('自定义引擎包 tau') < prompt.index('排查委派对话弹窗缺少快捷按钮')
    assert 'recent dialogue first, then recent relevant notifications' in prompt
    assert 'Persistent task snapshots do not establish the current topic or recency' in prompt
    assert 'If only delegation_id is given, look it up' in prompt
    assert 'missing or ambiguous, ask' in prompt
    assert notices[0]['id'] == 'older'
    session.extra['digital_person_context']['pending'] = []
    followup_prompt = module._chat_system_prompt(session)
    assert 'recent dialogue first, then recent relevant notifications' in followup_prompt
    assert '<conversation_notifications>' not in followup_prompt
