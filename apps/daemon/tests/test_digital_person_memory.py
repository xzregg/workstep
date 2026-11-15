from tests.memory_turn_fixture import create_completed_user,create_completed_reply
import asyncio
from datetime import timedelta

import pytest
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime
from models.chat_session import ChatMessage
from models.fields import utc_now


async def seed(runtime, text, mid='source', sid=None, role='user', when=None):
    sid = sid or (await runtime.main_session())['id']
    await runtime.projects.run_db((await runtime.home()).id, lambda _: (create_completed_user if role=='user' else create_completed_reply)(
        id=mid, session=sid, role=role, content=text, status='completed', created_at=when or utc_now()))
    return sid


async def test_memory_capture_is_durable_idempotent_and_scoped(runtime):
    from services.digital_person_memory import capture_session, recall, scope_for_session
    current, project, store = runtime
    sid = await seed(current, '我的生日是六月三号，我喜欢天文摄影。')
    def capture(_):
        scope = scope_for_session(sid)
        capture_session(sid, scope)
        capture_session(sid, scope)
        hits = recall(scope, '')
        assert len(hits) == 2
        hits=[hit for hit in hits if hit['role']=='user']
        assert hits[0]['source_message_id'] == 'source'
        assert hits[0]['role'] == 'user'
        assert recall('channel:another-person', '') == []
        return hits
    hits = await current.projects.run_db(project.id, capture)
    assert '六月三号' in hits[0]['content']


async def test_user_recalling_strengthens_once_but_background_reads_do_not(runtime):
    from services.digital_person_memory import capture_session, recall
    from services import digital_person_memory_index as index
    current, project, _ = runtime
    sid = await seed(current, '我喜欢天文摄影，最想拍银河。')
    def operation(_):
        capture_session(sid, 'local')
        row = index.candidates('local')[0]
        for _ in range(3):
            recall('local', '')
        assert index.candidates('local')[0]['reinforcements'] == 0
        for _ in range(3):
            recall('local', '', event_key='new-user-message')
        assert index.candidates('local')[0]['reinforcements'] == 1
    await current.projects.run_db(project.id, operation)


async def test_memory_can_be_forgotten_without_deleting_chat_and_not_recaptured(runtime):
    from services.digital_person_memory import capture_session, recall, forget
    current, project, _ = runtime
    sid = await seed(current, '我喜欢天文摄影。')
    def operation(_):
        capture_session(sid, 'local')
        hit = next(hit for hit in recall('local', '') if hit['role']=='user')
        forget(hit['id'])
        capture_session(sid, 'local')
        assert not any(hit['role']=='user' for hit in recall('local', ''))
        assert ChatMessage.get_by_id('source').content == '我喜欢天文摄影。'
    await current.projects.run_db(project.id, operation)


async def test_completed_chat_is_not_automatically_injected_into_another_session(runtime, monkeypatch):
    current, project, _ = runtime
    calls = []
    async def invoke(*args, **kwargs):
        calls.append(kwargs.get('system_prompt', ''))
        return '知道了', [], 'memory-engine'
    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    first = (await current.main_session())['id']
    second = await current.projects.run_db(project.id, lambda _: current.chats.create_session(project.id)['id'])
    for sid, text in [(first, '我最喜欢天文摄影。'), (second, '你记得我喜欢什么摄影吗？')]:
        turn = await current.projects.run_db(project.id, lambda _: current.chats.submit_message(project.id, sid, text, sid, schedule=False))
        current.chats.start_queued_turn(turn.turn_id)
        await current.chats.await_turn(turn.turn_id, timeout=5)
    assert '天文摄影' not in calls[1]
    assert 'Relevant memories' not in calls[1]
    assert 'memory search' in calls[1]


async def test_companion_budget_reduces_unanswered_contacts_and_recovers_on_user_reply(runtime):
    from services.digital_person_companion import contact_policy
    current, _, _ = runtime
    now = utc_now()
    companion = {'contacts': [{'at': now.isoformat(), 'run_id': 'r'}]}
    assert contact_policy(companion, None, now)['allowed'] is False
    assert contact_policy(companion, now + timedelta(hours=5), now + timedelta(hours=5, minutes=10))['allowed'] is True
    assert contact_policy({}, now, now)['allowed'] is False


async def test_companion_social_notification_is_not_a_work_report(runtime, monkeypatch):
    current, _, _ = runtime
    await seed(current, '昨天我说今天要面试，现在面试结束啦。', when=utc_now()-timedelta(minutes=2))
    async def decide(context):
        if context.get('_load'): await context['_load']()
        assert 'memory' in context and 'companion' in context
        return {'decision': 'notify', 'kind': 'social', 'summary': '面试结束啦，感觉怎么样？', 'source_ids': ['source'],
                'mood': 'warm', 'thought': {'content': '想关心面试感受', 'source_ids': ['source'], 'after_minutes': 60}}
    monkeypatch.setattr(current, '_decide', decide)
    monkeypatch.setattr('services.digital_person_channels.get_bindings', lambda: [])
    first = await current.check()
    assert first['status'] == 'notified', first
    assert first['kind'] == 'social'
    second = await current.check()
    assert second['sources']['no_work'] is True, second
    assert second['sources']['no_work'] is True


async def test_memory_api_slow_database_canary_and_host_auth(runtime, monkeypatch):
    import main
    import threading
    from fastapi import FastAPI
    from httpx import AsyncClient, ASGITransport
    from api.digital_person import router
    from services import digital_person_memory as memory
    from services.remote_access import ActorSnapshot, actor_context
    current, _, _ = runtime
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    entered, release = threading.Event(), threading.Event()
    original = memory.browse
    def slow(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return original(*args, **kwargs)
    monkeypatch.setattr(memory, 'browse', slow)
    app = FastAPI()
    app.include_router(router)
    @app.get('/health')
    async def health():
        return {'ok': True}
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        pending = asyncio.create_task(client.get('/api/digital-person/memory'))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            assert (await asyncio.wait_for(client.get('/health'), .3)).status_code == 200
        finally:
            release.set()
        assert (await pending).status_code == 200
        actor = ActorSnapshot(actor_id='u', user_name='u', device_id='d', device_name='d', source='remote_project', project_id='other', access_level='edit')
        with actor_context(actor):
            assert (await client.get('/api/digital-person/memory')).status_code == 403
            assert (await client.delete('/api/digital-person/memory/1')).status_code == 403


async def test_memory_deleted_with_source_and_classification_cannot_add_facts(runtime):
    from services.digital_person_memory import capture_session, recall, classify
    from services import digital_person_memory_index as index
    current, project, _ = runtime
    sid = await seed(current, '我喜欢天文摄影。')
    def operation(_):
        capture_session(sid, 'local')
        hit = next(hit for hit in recall('local', '') if hit['role']=='user')
        assert classify('other-person', [{'id': hit['id'], 'category': 'long'}], {hit['id']}) == []
        assert classify('local', [{'id': 'memory:999', 'category': 'long'}], {hit['id']}) == []
        assert classify('local', [{'id': hit['id'], 'category': 'long', 'importance': .9, 'content': '编造的生日'}], {hit['id']}) == [hit['id']]
        assert ChatMessage.get_by_id('source').content == '我喜欢天文摄影。'
        assert next(row for row in index.candidates('local') if row['role']=='user')['category'] == 'long'
        ChatMessage.delete().where(ChatMessage.id == 'source').execute()
        assert not any(hit['role']=='user' for hit in recall('local', ''))
        assert not any(row['role']=='user' for row in index.candidates('local'))
    await current.projects.run_db(project.id, operation)


async def test_channel_memories_cannot_leak_into_local_or_another_contact(runtime):
    from services.digital_person_memory import capture_session, recall, scope_for_session
    current, project, store = runtime
    sid = await seed(current, '我的生日是六月三日。', when=utc_now()-timedelta(minutes=2))
    store.set('channel_bots', {'sessions': {'bot:single:alice': sid}, 'session_sources': {sid: {}}})
    def operation(_):
        scope = scope_for_session(sid)
        assert scope == 'channel:bot:single:alice'
        capture_session(sid, scope)
        assert recall(scope, '')
        assert recall('local', '') == []
        assert recall('channel:bot:single:bob', '') == []
    await current.projects.run_db(project.id, operation)
    store.set('channel_bots', {'sessions': {}, 'session_sources': {sid: {}}})
    assert await current.projects.run_db(project.id, lambda _: scope_for_session(sid)) == 'session:' + sid


async def test_decay_is_layered_without_destroying_originals(runtime):
    from services.digital_person_memory import capture_session
    from services import digital_person_memory_index as index
    current, project, _ = runtime
    sid = await seed(current, '过去发生的一件事。')
    def operation(_):
        capture_session(sid, 'local')
        row = index.candidates('local')[0]
        later = utc_now() + timedelta(days=60)
        row['category'] = 'short'
        short = index.power(row, later)
        row['category'] = 'long'
        assert index.power(row, later) > short
        assert ChatMessage.get_by_id('source').content == '过去发生的一件事。'
    await current.projects.run_db(project.id, operation)


async def test_recent_birthday_can_trigger_main_message_and_enabled_channel_notice(runtime, monkeypatch):
    from services.digital_person_memory import capture_session, recall
    current, project, _ = runtime
    sid = await seed(current, '我的生日是六月三日。', when=utc_now()-timedelta(minutes=2))
    def capture(_):
        capture_session(sid, 'local')
        return recall('local', '')[0]['id']
    memory_id = await current.projects.run_db(project.id, capture)
    async def decide(context):
        if context.get('_load'): await context['_load']()
        assert context['memory']==[]
        return {'decision': 'notify', 'kind': 'social', 'summary': '你说生日在六月三日，平常喜欢怎么过？', 'source_ids': ['source']}
    sent = []
    async def send(*args):
        sent.append(args)
        return {}
    monkeypatch.setattr(current, '_decide', decide)
    monkeypatch.setattr('services.digital_person_channels.get_bindings', lambda: [
        {'id': 'someone-else', 'bot_id': 'b', 'conversation_type': 'single', 'conversation_id': 'other', 'notify': True}])
    monkeypatch.setattr('services.digital_person_channels.send_binding', send)
    run = await current.check()
    assert run['status'] == 'notified', run
    assert len(sent) == 1
    assert [r['session_id'] for r in run['deliveries'] if r['kind']=='local'] == [sid]


async def test_pending_work_does_not_enable_social_when_proactive_is_off(runtime, monkeypatch):
    current, _, _ = runtime
    sid = await seed(current, '你好')
    await current.mutate(lambda s: s['delegations'].append({'id': 'work', 'project_id': (sid), 'origin_session_id': sid, 'message_id': 'missing', 'notified': False}))
    async def decide(context):
        if context.get('_load'): await context['_load']()
        return {'decision': 'notify', 'kind': 'social', 'summary': '想问问你的近况', 'source_ids': ['source']}
    monkeypatch.setattr(current, '_decide', decide)
    from services.memory_knowledge import ensure_schema
    await asyncio.to_thread(ensure_schema)
    run = await current.check(manual=False)
    assert run['status'] == 'silent', run
    assert run['deliveries'] == []


async def test_retired_thought_output_is_ignored(runtime, monkeypatch):
    from services.digital_person_companion import snapshot
    current, _, _ = runtime
    await seed(current, '明天我要去面试。')
    async def decide(context):
        if context.get('_load'): await context['_load']()
        return {'decision': 'silent', 'summary': '稍后再关心', 'source_ids': [], 'mood': 'curious',
                'thought': {'content': '想知道面试感受', 'source_ids': ['source'], 'after_minutes': 60}}
    monkeypatch.setattr(current, '_decide', decide)
    assert (await current.check())['status'] == 'silent'
    state = await current.state()
    current_thought = snapshot(state, 'local', None, utc_now())
    assert current_thought['thought'] is None
    assert current_thought['mood'] == 'calm'
    assert snapshot(state, 'local', None, utc_now()+timedelta(days=2))['thought'] is None
    async def forged(context):
        return {'decision': 'silent', 'summary': '', 'source_ids': [],
                'thought': {'content': '伪造念头', 'source_ids': ['unknown'], 'after_minutes': 60}}
    monkeypatch.setattr(current, '_decide', forged)
    await current.check()
    assert not (await current.state())['companions']['local'].get('thought')


async def test_explicit_stop_contact_survives_later_chitchat_and_only_blocks_social(runtime, monkeypatch):
    current, _, _ = runtime
    await seed(current, '不要主动联系我了')
    async def social(context):
        if context.get('_load'): await context['_load']()
        return {'decision': 'notify', 'kind': 'social', 'summary': '最近怎么样？', 'source_ids': [context['conversation'][0]['id']]}
    monkeypatch.setattr(current, '_decide', social)
    assert (await current.check())['status'] == 'silent'
    await seed(current, '今天好累。', mid='later')
    assert (await current.check())['status'] == 'silent'
    assert (await current.state())['companions']['local']['opted_out'] is True


async def test_retired_thought_does_not_reopen_old_evidence(runtime):
    from services.digital_person_companion import reflect
    current, _, _ = runtime
    sid = await seed(current, '明天面试，有空问问我感觉吧。')
    await current.mutate(lambda state: reflect(state, 'local', {'thought': {'content': '关心面试感受', 'source_ids': ['source'], 'after_minutes': 1}}, {'source'}, utc_now()))
    from services import digital_person_reflection as reflection, digital_person_assessment as assessment
    from services.digital_person_memory import sync_projects
    await sync_projects(current.projects)
    await asyncio.to_thread(assessment.commit, await asyncio.to_thread(reflection.pending, (await current.home()).id), [], 'earlier-run')
    for index in range(22):
        await seed(current, '继续聊别的事情', mid='filler-'+str(index), sid=sid)
    context = await current._collect()
    assert 'source' not in {m['id'] for m in context['conversation']}
    assert context['thought_sources']==[]


async def test_edited_source_reindexes_and_removes_obsolete_tail(runtime):
    from services.digital_person_memory import capture_session, recall
    from services import digital_person_memory_index as index
    current, project, _ = runtime
    sid = await seed(current, '我喜欢天文摄影。' + '旧经历'*300)
    def operation(_):
        capture_session(sid, 'local')
        assert len(index.candidates('local')) == 2
        ChatMessage.update(content='我喜欢潜水。').where(ChatMessage.id == 'source').execute()
        capture_session(sid, 'local')
        assert len(index.candidates('local')) == 2
        assert next(hit for hit in recall('local', '') if hit['role']=='user')['content']=='我喜欢潜水。'
        assert recall('local', '潜水')==[]  # Raw text is no longer globally indexed.
    await current.projects.run_db(project.id, operation)


async def test_completed_work_bypasses_social_contact_budget(runtime, monkeypatch):
    current, project, _ = runtime
    sid = await seed(current, '关注这个任务的结果。')
    await seed(current, '任务完成，测试通过。', mid='work-result', sid=sid, role='assistant')
    def state(s):
        s['companions'] = {'local': {'opted_out': True, 'contacts': [{'at': utc_now().isoformat(), 'run_id': 'previous'}]}}
    await current.mutate(state)
    async def decide(context):
        if context.get('_load'): await context['_load']()
        assert context['companion']['contact_policy']['allowed'] is False
        return {'decision': 'notify', 'kind': 'work', 'summary': '任务已完成，测试通过。', 'source_ids': ['work-result']}
    monkeypatch.setattr(current, '_decide', decide)
    monkeypatch.setattr('services.digital_person_channels.get_bindings', lambda: [])
    run = await current.check()
    assert run['status'] == 'notified', run
    assert len(run['deliveries']) == 1


async def test_memory_time_search_intersects_keyword_and_date(runtime):
    from services.digital_person_memory import capture_session, browse
    current, project, _ = runtime
    now = utc_now()
    sid = await seed(current, '我喜欢天文摄影。', when=now-timedelta(days=3))
    await seed(current, '昨天拍摄了天文摄影作品。', mid='newer', sid=sid, when=now-timedelta(days=1))
    def operation(_):
        capture_session(sid, 'local')
        hits = browse(scope='local', query='', since=now-timedelta(days=2), before=now)
        assert {hit['source_message_id'] for hit in hits} == {'newer','fixture-reply-newer'}
    await current.projects.run_db(project.id, operation)


async def test_disabling_digital_person_stops_capture_even_in_existing_session(runtime, monkeypatch):
    from services.digital_person_memory import recall
    current, project, store = runtime
    async def invoke(*args, **kwargs):
        return '收到', [], 'native-thread'
    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    sid = (await current.main_session())['id']
    for enabled, text in [(True, '我喜欢天文摄影。'), (False, '我喜欢深海潜水。')]:
        store.set('digital_person', {'enabled': enabled})
        turn = await current.projects.run_db(project.id, lambda _: current.chats.submit_message(project.id, sid, text, text, schedule=False))
        current.chats.start_queued_turn(turn.turn_id)
        await current.chats.await_turn(turn.turn_id, timeout=5)
    hits = await current.projects.run_db(project.id, lambda _: recall('local', '深海潜水'))
    assert hits == []


async def test_channel_engine_uses_only_its_own_memory_tools(runtime, monkeypatch):
    from agent_assistants.channel_chat import ChannelChatModule
    current, project, store = runtime
    current.chats = ChannelChatModule(current.bus, current.projects, register=False)
    monkeypatch.setattr('agent_assistants.channel_chat.config_store', store)
    a = await current.projects.run_db(project.id, lambda _: current.chats.create_session(project.id)['id'])
    b = await current.projects.run_db(project.id, lambda _: current.chats.create_session(project.id)['id'])
    store.set('channel_bots', {'sessions': {'bot:single:alice': a, 'bot:single:bob': b}, 'session_sources': {a: {}, b: {}}})
    prompts = []
    async def invoke(*args, **kwargs):
        prompts.append(kwargs.get('system_prompt', ''))
        return '收到', [], 'channel-thread'
    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    for index, (sid, text) in enumerate([(a, '我喜欢天文摄影。'), (a, '还记得我的摄影偏好吗？'), (b, '你知道我的摄影偏好吗？')]):
        turn = await current.projects.run_db(project.id, lambda _: current.chats.submit_message(project.id, sid, text, str(index), schedule=False))
        current.chats.start_queued_turn(turn.turn_id)
        await current.chats.await_turn(turn.turn_id, timeout=5)
    assert '天文摄影' not in prompts[1]
    assert '天文摄影' not in prompts[2]
    from services import memory_query
    alice_token=prompts[1].split('Pass memory_token=',1)[1].split(' ',1)[0]
    bob_token=prompts[2].split('Pass memory_token=',1)[1].split(' ',1)[0]
    own=await memory_query.search(current.projects,alice_token,query='天文摄影')
    assert own['items']==[] and own['knowledge']==[]  # Unprocessed sources are not knowledge hits.
    bob_hits=(await memory_query.search(current.projects,bob_token,query='天文摄影'))['items']
    assert all(hit['session_id']==b and '天文摄影' not in hit['content'] for hit in bob_hits)
    with pytest.raises(LookupError):
        await memory_query.read(current.projects,bob_token,own['items'][0]['id'])
