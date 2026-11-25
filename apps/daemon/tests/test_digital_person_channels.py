import pytest
from tests.test_channel_bots import bots
from services.channels.bots import IncomingMessage

async def test_selected_peer_routes_to_digital_person_and_unbind_restores_original(bots,monkeypatch):
    from services import digital_person_channels as peers, digital_person, customization_workspace
    manager, first, home, _, chats, adapters=bots
    monkeypatch.setattr(peers,'config_store',manager._store)
    monkeypatch.setattr(digital_person,'config_store',manager._store)
    manager._store.set('digital_person',{'enabled':True})
    async def workspace(_):return home
    monkeypatch.setattr(customization_workspace,'ensure_default_workspace',workspace)
    bot=await manager.create_bot({'platform':'wecom','name':'peer-bot','app_id':'peer','secret':'s','enabled':True,'default_target_type':'project','default_project_id':first.id})
    # Bindings retain original bot routing; only the selected peer is redirected.
    manager._store.set(peers.KEY,[{'session_id':'source','project_id':first.id,'bot_id':bot['id'],'conversation_type':'single','conversation_id':'selected','notify':False}])
    await manager.handle_message(IncomingMessage(bot['id'],'one','single','selected','selected','hello'))
    assert chats[-1][0]==home.id
    await manager.handle_message(IncomingMessage(bot['id'],'two','single','other','other','hello'))
    assert chats[-1][0]==first.id
    await peers.unbind(peers.get_bindings()[0]['id'])
    await manager.handle_message(IncomingMessage(bot['id'],'three','single','selected','selected','hello'))
    assert chats[-1][0]==first.id
    assert (await manager.list_bots())[0]['default_project_id']==first.id


async def test_bind_peer_without_chat_and_default_task_wins(bots, monkeypatch):
    from services import digital_person_channels as peers, digital_person
    manager, first, _, _, chats, _ = bots
    monkeypatch.setattr(peers, 'config_store', manager._store)
    monkeypatch.setattr(digital_person, 'config_store', manager._store)
    manager._store.set('digital_person', {'enabled': True})
    bot = await manager.create_bot({'platform':'wecom','name':'task bot','app_id':'peer2','secret':'s',
        'enabled':True,'default_target_type':'task','default_project_id':first.id,'default_task_id':'task-1'})
    manager._private_users.setdefault(bot['id'], {})['person'] = {'sender_id':'person','sender_name':'Person'}
    bound = await peers.bind(manager, manager._project_manager, bot_id=bot['id'],
                            conversation_type='single', conversation_id='person', notify=True, use_main_session=True)
    assert 'session_id' not in bound
    assert bound['id']
    calls = []
    async def task_reply(project_id, task_id, *args, **kwargs):
        calls.append((project_id, task_id))
        return 'task reply'
    monkeypatch.setattr(manager, '_task_reply', task_reply)
    await manager.handle_message(IncomingMessage(bot['id'],'first','single','person','person','hello'))
    assert calls == [(first.id, 'task-1')]
    assert not chats
    await peers.unbind(bound['id'])
    assert not peers.get_bindings()


async def test_binding_and_delivery_survive_without_a_chat(bots, monkeypatch):
    from services import digital_person_channels as peers
    manager, first, _, _, _, adapters = bots
    monkeypatch.setattr(peers, 'config_store', manager._store)
    bot = await manager.create_bot({'platform':'wecom','name':'bot','app_id':'independent','secret':'s',
        'enabled':True,'default_target_type':'project','default_project_id':first.id})
    data = await manager._load()
    data['recent_groups'].append({'bot_id':bot['id'],'group_id':'group','group_name':'研发群'})
    await manager._save(data)
    binding = await peers.bind(manager, manager._project_manager, bot_id=bot['id'],
        conversation_type='group', conversation_id='group')
    assert not (await manager._load())['sessions']
    assert (await peers.send_binding(manager, binding, 'hello'))['sent']
    assert adapters[bot['id']].sent == [('group', 'hello')]
    assert peers.get_bindings()[0]['id'] == binding['id']


async def test_main_session_option_is_explicit_and_only_available_for_private_peers(bots, monkeypatch):
    from services import digital_person_channels as peers
    manager, first, _, _, _, _ = bots
    monkeypatch.setattr(peers, 'config_store', manager._store)
    bot = await manager.create_bot({'platform':'wecom','name':'bot','app_id':'shared-main','secret':'s',
        'enabled':True,'default_target_type':'project','default_project_id':first.id})
    manager._private_users.setdefault(bot['id'], {})['owner'] = {'sender_id':'owner','sender_name':'Owner'}
    kwargs = dict(bot_id=bot['id'], conversation_type='single', conversation_id='owner')
    independent = await peers.bind(manager, manager._project_manager, **kwargs)
    assert independent['use_main_session'] is False
    shared = await peers.bind(manager, manager._project_manager, **kwargs, use_main_session=True)
    assert shared['id'] == independent['id'] and shared['use_main_session'] is True
    assert len(peers.get_bindings()) == 1
    manager._private_users.clear()
    restored = await peers.bind(manager, manager._project_manager, **kwargs, use_main_session=False)
    assert restored['use_main_session'] is False
    with pytest.raises(ValueError, match='private'):
        await peers.bind(manager, manager._project_manager, bot_id=bot['id'],
                         conversation_type='group', conversation_id='group', use_main_session=True)


@pytest.mark.parametrize('quoted', [False, True])
async def test_reset_command_is_not_consumed_as_review_comment(bots, monkeypatch, quoted):
    from services.channels.base import ChannelQuote
    from agent_assistants.context_commands import reset_command
    manager, first, _, _, chats, adapters = bots
    bot = await manager.create_bot({'platform':'wecom','name':'bot','app_id':'reset','secret':'s',
        'enabled':True,'default_target_type':'project','default_project_id':first.id})
    async def review(_):
        raise AssertionError('Control commands must bypass review input')
    monkeypatch.setattr(manager._controls, 'review_message', review)
    await manager.handle_message(IncomingMessage(bot['id'],'clear','single','user','user','/clear',
        quote=ChannelQuote(text='quoted context') if quoted else None))
    content = chats[-1][2].rsplit('\n\n', 1)[-1] if not quoted else chats[-1][2]
    if quoted:
        assert '/clear\n引用消息：' in content
    else:
        assert reset_command(content) == ''
