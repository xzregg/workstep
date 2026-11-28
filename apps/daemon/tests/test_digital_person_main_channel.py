import json
from types import SimpleNamespace

import pytest

from agent_assistants.channel_chat import ChannelChatModule
from models.chat_session import ChatMessage, ChatSession
from services.channels.bots import BotManager, IncomingMessage
from services.channels.responder import ChatSessionResponder
from services.channels.session_source import channel_session_source
from services import digital_person_channels as peers
from tests.test_channel_bots import FakeAdapter
from tests.test_digital_person_runtime import chat_module, runtime


async def test_private_channel_uses_actual_main_runtime_and_switches_back_without_moving_history(runtime, monkeypatch):
    import main as daemon
    from httpx import ASGITransport, AsyncClient
    current, home, store = runtime
    channel = ChannelChatModule(current.bus, current.projects, register=False)
    responder = ChatSessionResponder(current.bus, current.projects, channel)
    adapters = {}

    def factory(bot, on_message, on_state):
        adapters[bot['id']] = FakeAdapter(bot, on_message, on_state)
        return adapters[bot['id']]

    manager = BotManager(store, current.projects, current.bus, None, responder,
                         adapter_factories={'wecom': factory})
    manager.set_digital_person(current)
    current.bots = manager
    monkeypatch.setattr(daemon, 'digital_person_runtime', current)
    monkeypatch.setattr(peers, 'config_store', store)
    monkeypatch.setattr('agent_assistants.channel_chat.config_store', store)
    monkeypatch.setattr('services.channels.session_source.config_store', store)
    calls = []

    async def invoke(*args, **kwargs):
        calls.append(kwargs)
        return '收到', [], 'native-main'

    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    bot = await manager.create_bot({'platform': 'wecom', 'name': '个人机器人', 'app_id': 'main-test',
        'secret': 's', 'enabled': True, 'default_target_type': 'project', 'default_project_id': home.id})
    binding = {'bot_id': bot['id'], 'conversation_type': 'single', 'conversation_id': 'owner', 'notify': True}
    store.set(peers.KEY, [binding])
    route = f"{bot['id']}:single:owner"

    async def send(mid, who='owner'):
        await manager.handle_message(IncomingMessage(bot['id'], mid, 'single', who, who, f'问题 {mid}'))

    async def set_mode(enabled):
        async with AsyncClient(transport=ASGITransport(app=daemon.app), base_url='http://test') as client:
            response = await client.put('/api/digital-person/channels', json={**binding, 'use_main_session': enabled})
            assert response.status_code == 200, response.text
            assert response.json()['use_main_session'] is enabled
            invalid = await client.put('/api/digital-person/channels', json={
                **binding, 'conversation_type': 'group', 'use_main_session': True})
            assert invalid.status_code == 400

    try:
        await send('independent')
        independent = (await manager._load())['sessions'][route]
        main = (await current.main_session())['id']
        assert independent != main
        await set_mode(True)
        await send('shared')
        assert responder._module_for('chat_session') is current.chats
        assert (await manager._load())['sessions'][route] == independent
        assert main not in (await manager._load())['session_sources']
        messages = await current.projects.run_db(home.id, lambda _: list(ChatMessage.select().where(
            ChatMessage.session == main, ChatMessage.role == 'user')))
        assert len(messages) == 1 and messages[0].content == '问题 shared'
        source = json.loads(messages[0].context_json)['channel_source']
        assert source['bot_id'] == bot['id'] and source['sender_id'] == 'owner'
        assert messages[0].author_id == 'channel:wecom:owner'
        assert '<current_channel_source>' in calls[-1]['system_prompt']
        assert '问题 shared' not in calls[-1]['system_prompt']
        assert await current.projects.run_db(home.id, lambda _: channel_session_source(main)) == {'source': 'chat'}
        # Another contact on the same bot does not inherit this route.
        await send('other', 'someone-else')
        assert (await manager._load())['sessions'][f"{bot['id']}:single:someone-else"] != main
        # The foreground turn uses the same runtime, without stale channel source.
        def browser_turn(_):
            return current.chats.submit_message(home.id, main, '工作台继续', 'browser', schedule=False)
        from tests.test_chat_session import _wait_turn
        accepted = await current.projects.run_db(home.id, browser_turn)
        current.chats.start_queued_turn(accepted.turn_id)
        assert await _wait_turn(current.chats, accepted.turn_id) == 'completed'
        assert '<current_channel_source>' not in calls[-1]['system_prompt']
        await set_mode(False)
        await send('separate-again')
        assert (await manager._load())['sessions'][route] == independent
        # A later archive resolves a new canonical main instead of reusing the old one.
        await current.projects.run_db(home.id, lambda _: ChatSession.update(archived=True).where(ChatSession.id == main).execute())
        await set_mode(True)
        await send('recreated')
        replacement = (await current.main_session())['id']
        assert replacement != main
        assert await current.projects.run_db(home.id, lambda _: ChatMessage.select().where(
            ChatMessage.session == replacement, ChatMessage.role == 'user', ChatMessage.content == '问题 recreated').exists())
        assert len(adapters[bot['id']].sent) == 5
    finally:
        await manager.shutdown()
        await channel.shutdown()


@pytest.mark.parametrize('main_origin', [True, False])
async def test_notification_destinations_follow_actual_conversation_scope(runtime, monkeypatch, main_origin):
    current, _, _ = runtime
    main = (await current.main_session())['id']
    origin = main if main_origin else 'independent'
    bindings = [
        {'id': 'own-a', 'bot_id': 'a', 'conversation_type': 'single', 'conversation_id': 'owner', 'notify': True, 'use_main_session': True},
        {'id': 'own-b', 'bot_id': 'b', 'conversation_type': 'single', 'conversation_id': 'owner', 'notify': True, 'use_main_session': True},
        {'id': 'separate', 'bot_id': 'a', 'conversation_type': 'single', 'conversation_id': 'other', 'notify': True},
        {'id': 'muted', 'bot_id': 'c', 'conversation_type': 'single', 'conversation_id': 'owner', 'notify': False, 'use_main_session': True},
    ]
    async def load():
        return {'sessions': {'a:single:other': 'independent'}, 'session_sources': {'independent': {}}}
    current.bots = SimpleNamespace(_load=load)
    sent, local = [], []
    async def send(_, binding, text):
        sent.append(binding['id'])
        return {'message_id': binding['id']}
    async def deliver(sid, *args, **kwargs):
        local.append(sid)
    monkeypatch.setattr(peers, 'get_bindings', lambda: bindings)
    monkeypatch.setattr(peers, 'send_binding', send)
    monkeypatch.setattr(current, '_deliver_local', deliver)
    await current.mutate(lambda state: state['runs'].append({
        'id': 'notice', 'origin_session_id': origin, 'managed_followup': True, 'automatic_followup': True}))
    await current._notify('任务有进展', [], 'notice')
    assert local == [origin]
    assert sent == (['own-a', 'own-b'] if main_origin else ['separate'])
