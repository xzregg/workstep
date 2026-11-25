import asyncio
import pytest

from tests.test_digital_person_runtime import chat_module, runtime


async def test_five_tasks_with_ten_followups_keep_five_stable_task_ids(runtime, monkeypatch, tmp_path):
    current, _, store = runtime
    store.set('digital_person', {'enabled': True})
    target = await asyncio.to_thread(current.projects.init_project, tmp_path / 'tasks')
    origin = (await current.main_session())['id']

    async def invoke(*args, **kwargs):
        return 'Checked', [], 'worker'

    monkeypatch.setattr(current.chats, '_invoke', invoke)
    tasks = []
    for i in range(5):
        task = await current.delegate(target.id, f'Task {i}', origin, f'create-{i}', title=f'Task {i}')
        await current.chats.await_turn(task['turn_id'], timeout=2)
        tasks.append(task)
    for i in range(10):
        result = await current.delegate(target.id, f'Follow up {i}', origin, f'follow-{i}', tasks[0]['id'],
                                        title='Latest title' if i == 9 else None)
        await current.chats.await_turn(result['turn_id'], timeout=2)
        assert result['id'] == tasks[0]['id']
        assert result['session_id'] == tasks[0]['session_id']
        assert result['operation'] == 'updated'
    assert tasks[0]['operation'] == 'created'
    state = await current.state()
    assert len(state['delegations']) == 5
    assert len(state['delegation_executions']) == 10
    assert len({row['execution_id'] for row in [*state['delegations'], *state['delegation_executions']]}) == 15
    assert {row['id'] for row in (await current.list_delegations())['items']} == {task['id'] for task in tasks}
    replay = await current.delegate(target.id, 'Follow up 0', origin, 'follow-0', tasks[0]['id'])
    assert replay['id'] == tasks[0]['id']
    assert replay['execution_id'] != result['execution_id']
    assert len((await current.state())['delegation_executions']) == 10
    appended = await current.delegate(target.id, 'Verify again', origin, 'target-again',
                                      target_session_id=tasks[0]['session_id'])
    await current.chats.await_turn(appended['turn_id'], timeout=2)
    assert appended['id'] == tasks[0]['id']
    assert appended['title'] == 'Latest title'
    assert len((await current.state())['delegations']) == 5


def test_legacy_turns_merge_without_losing_history_or_old_identifiers():
    from services.digital_person_tasks import normalize_tasks, resolve_task

    state = {'delegations': [
        {'id': 'first', 'project_id': 'p', 'session_id': 's', 'message_id': 'a', 'created_at': '2026-11-21'},
        {'id': 'second', 'project_id': 'p', 'session_id': 's', 'message_id': 'b',
         'continuation_of': 'first', 'created_at': '2026-11-22', 'status': 'running'},
    ]}
    normalize_tasks(state)
    task, = state['delegations']
    assert (task['id'], task['execution_id'], task['message_id']) == ('first', 'second', 'b')
    assert resolve_task(state, 'second') == task
    assert state['delegation_executions'][0]['message_id'] == 'a'
    normalize_tasks(state)
    assert len(state['delegation_executions']) == 1


async def test_bound_channels_only_see_and_continue_tasks_from_their_actual_session(runtime, monkeypatch, tmp_path):
    current, home, store = runtime
    store.set('digital_person', {'enabled': True})
    target = await asyncio.to_thread(current.projects.init_project, tmp_path / 'shared-tasks')
    main = (await current.main_session())['id']
    peers = await current.projects.run_db(home.id, lambda _: [
        current.chats.create_session(home.id, title=name)['id'] for name in ('WeChat', 'Telegram', 'Unbound')])
    store.set('channel_bots', {'sessions': {'bot:single:a': peers[0], 'bot:single:b': peers[1]}})
    store.set('digital_person_channels', [
        {'bot_id': 'bot', 'conversation_type': 'single', 'conversation_id': key} for key in ('a', 'b')])
    monkeypatch.setattr('services.digital_person_channels.config_store', store)

    async def invoke(*args, **kwargs):
        return 'Checked', [], 'worker'
    monkeypatch.setattr(current.chats, '_invoke', invoke)
    created = []
    for i, origin in enumerate((main, peers[0], peers[1], peers[2])):
        task = await current.delegate(target.id, f'Task {i}', origin, f'shared-{i}')
        await current.chats.await_turn(task['turn_id'], timeout=2)
        created.append(task)
    await current.mutate(lambda state: state['delegations'][0].update(followup_state='completed'))
    for index, origin in enumerate((main, *peers)):
        rows = await current.delegation_management.for_conversation(origin)
        assert {row['id'] for row in rows} == {created[index]['id']}
    with pytest.raises(ValueError, match='does not belong'):
        await current.delegate(target.id, 'Cross-session continuation', peers[1], 'cross-follow', created[1]['id'])
    with pytest.raises(ValueError, match='another source'):
        await current.delegate(target.id, 'Cross-session target', peers[1], 'cross-target',
                               target_session_id=created[1]['session_id'])
    continued = await current.delegate(target.id, 'Follow up from same session', peers[0], 'own-follow', created[1]['id'])
    await current.chats.await_turn(continued['turn_id'], timeout=2)
    assert continued['id'] == created[1]['id']
    assert continued['origin_session_id'] == peers[0]
    assert continued['request_origin_session_id'] == peers[0]
    assert (await current.delegation_management.for_conversation(main))[0]['id'] == created[0]['id']


async def test_old_execution_status_and_finish_cannot_overwrite_latest_task(runtime):
    current, _, _ = runtime
    old = {'id': 'task', 'execution_id': 'old', 'message_id': 'old-message', 'status': 'running',
           'followup_state': 'pending', 'question': None}
    latest = {**old, 'execution_id': 'new', 'message_id': 'new-message', 'status': 'queued'}
    await current.mutate(lambda state: state.update(delegations=[latest], delegation_executions=[old]))
    await current.delegation_management.update_statuses({('task', 'old-message'): 'completed'})
    await current.delegation_management._finish({**old, 'status': 'completed'}, 'completed')
    state = await current.state()
    assert state['delegations'][0]['status'] == 'queued'
    assert state['delegations'][0]['followup_state'] == 'pending'
    assert state['delegation_executions'][0]['status'] == 'completed'


@pytest.mark.parametrize('bound', [True, False])
async def test_each_execution_notifies_its_source_once_without_broadcasting_to_other_conversations(runtime, monkeypatch, tmp_path, bound):
    from types import SimpleNamespace
    from models.chat_session import ChatMessage
    from services.digital_person import get_profile

    current, home, store = runtime
    store.set('digital_person', {'enabled': True, 'quiet_start': 0, 'quiet_end': 0})
    target = await asyncio.to_thread(current.projects.init_project, tmp_path / 'notices')
    main = (await current.main_session())['id']
    peer = await current.projects.run_db(home.id, lambda _: current.chats.create_session(home.id, title='Channel')['id'])
    bindings = [{'id': key, 'bot_id': key, 'conversation_type': 'single', 'conversation_id': 'user',
                 'notify': key != 'muted'} for key in ('wechat', 'telegram', 'muted')]
    store.set('channel_bots', {'sessions': {'wechat:single:user': peer} if bound else {}})
    monkeypatch.setattr('services.digital_person_channels.config_store', store)
    monkeypatch.setattr('services.digital_person_channels.get_bindings', lambda: bindings)
    sends = []

    async def send_binding(manager, binding, text):
        sends.append((binding['id'], text))
        return {'message_id': f'notice-{len(sends)}'}

    async def load():
        return {'sessions': store.get('channel_bots')['sessions'], 'session_sources': {peer: {}}}

    async def invoke(*args, **kwargs):
        return 'Checked', [], 'worker'

    current.bots = SimpleNamespace(_load=load)
    monkeypatch.setattr('services.digital_person_channels.send_binding', send_binding)
    monkeypatch.setattr(current.chats, '_invoke', invoke)
    task = await current.delegate(target.id, 'Verify', peer, 'notify-first')
    for index in range(2):
        if index:
            task = await current.delegate(target.id, 'Verify again', peer, 'notify-second', task['id'])
        await current.chats.await_turn(task['turn_id'], timeout=2)
        await current.delegation_management.refresh()
        eligible = await current.delegation_management.eligible(await current.state())
        action = [{'id': task['id'], 'action': 'complete', 'summary': f'Result {index}', 'evidence': 'Checked'}]
        await current.delegation_management.apply(action, eligible, get_profile())
        await current.delegation_management.apply(action, eligible, get_profile())
    notices = await current.projects.run_db(home.id, lambda _: [row.content for row in
        ChatMessage.select().where(ChatMessage.session == peer).order_by(ChatMessage.created_at)])
    assert notices == ['Result 0', 'Result 1']
    assert not await current.projects.run_db(home.id, lambda _: ChatMessage.select().where(ChatMessage.session == main).exists())
    assert sends == ([('wechat', 'Result 0'), ('wechat', 'Result 1')] if bound else [])
    state = await current.state()
    assert len(state['delegations']) == 1
    assert len(state['delegation_executions']) == 1
    assert len([run for run in state['runs'] if run.get('managed_followup')]) == 2
