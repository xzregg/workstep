"""Automatic-step cards use the original review runtime and clicker's identity."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from models import Message, ReviewRun, StepRun, Task, TaskStep, WorkflowRun
from services.channels.base import ChannelAction
from services.channels.controls import ChannelControls
from services.channels.task_controls import ChannelTaskControls
from services.intervention import intervention_manager
from services.project import ProjectManager
from services.remote_access import get_current_actor
from streaming.bus import EventBus


class Store:
    def __init__(self): self.rows = {}
    def get(self, key, default=None): return self.rows.get(key, default)
    def set(self, key, value): self.rows[key] = value


async def until(predicate):
    async with asyncio.timeout(2):
        while not predicate(): await asyncio.sleep(.005)


@pytest.fixture
async def setup(tmp_path):
    projects = ProjectManager()
    project = projects.init_project(tmp_path / 'cards')
    project.workflows = [{'id':'workflow', 'steps':{'nodes':[{'id':1,'type':'build','title':'构建'}]}}]
    def seed(_project):
        task = Task.create(id='task', title='任务', cwd=str(project.path), workflow_id='workflow',
            active_workflow_run_id='run', status='paused', created_at='2026-10-04', updated_at='2026-10-04')
        run = WorkflowRun.create(id='run', task=task, status='paused', workflow_schema_version=1, started_at='2026-10-04')
        step = StepRun.create(id='step', run=run, step_key='build', attempt=1, status='succeeded', started_at='2026-10-04')
        ReviewRun.create(id='review', workflow_run=run, step_run=step, task=task, step_key='build',
            mode='manual', status='pending', started_at='2026-10-04')
        Message.create(id='message', task=task, step_key='build', step_run_id='step', role='assistant',
            channel='execution', content='构建结果', position=1, created_at='2026-10-04')
        Message.create(id='review-message', task=task, step_key='build', step_run_id='step', role='assistant',
            channel='review', content='等待人工审核', position=2, run_status='running', created_at='2026-10-04')
        TaskStep.create(task=task, step_key='build', status='awaiting_review')
    await projects.run_db(project.id, seed)
    data = {'bots':[{'id':'bot','enabled':True,'platform':'wecom'}], 'sessions':{},
        'groups':[{'bot_id':'bot','group_id':g,'project_id':project.id,'task_id':'task'} for g in ('one','two')]}
    adapter = SimpleNamespace(send_card=AsyncMock(), update_card=AsyncMock())
    runtime = SimpleNamespace(decide_review=AsyncMock())
    store = Store()
    controls = ChannelControls(store, AsyncMock(return_value=data), {'bot':adapter}, SimpleNamespace(),
        SimpleNamespace(), AsyncMock(), workflow_runtime=runtime, projects=projects)
    bus = EventBus()
    relay = ChannelTaskControls(bus, projects, controls._load_config, controls)
    await relay.start()
    def event(name, **value):
        return {'type':'CUSTOM','name':name,'project_id':project.id,'task_id':'task',
            'step_key':'build','channel':'execution','messageId':'message','value':value}
    yield relay, bus, event, adapter, controls, runtime, projects, project, data, store
    await relay.shutdown()
    assert not bus._subscribers
    projects.close_all()


async def test_manual_review_broadcast_has_no_stop_and_uses_clicker_identity(setup):
    relay,bus,event,adapter,controls,runtime,projects,project,data,store = setup
    actors = []
    async def decide(*args): actors.append(get_current_actor())
    runtime.decide_review.side_effect = decide
    await bus.publish(event('workstep.review_result', review_run_id='review', status='awaiting_review'))
    await until(lambda: adapter.send_card.await_count == 2)
    card = adapter.send_card.await_args_list[0].args[1]
    group = adapter.send_card.await_args_list[0].args[0].conversation_id
    assert [b.label for b in card.buttons] == ['通过','不通过']
    assert not card.running
    assert '构建' in card.title and '构建结果' in card.text
    assert await controls.handle(ChannelAction('bot',card.id,'0','member',conversation_id='wrong')) == '该操作不属于此会话'
    assert await controls.handle(ChannelAction('bot',card.id,'0','member',conversation_id=group,sender_name='小李')) == '小李 审核通过'
    runtime.decide_review.assert_awaited_once_with(project.id,'task','build','review','approve')
    assert actors[0].actor_id == 'channel:wecom:member'
    assert actors[0].user_name == '企业微信 · 小李'
    other_recipient,other = adapter.send_card.await_args_list[1].args
    assert await controls.handle(ChannelAction('bot',other.id,'1','other',conversation_id=other_recipient.conversation_id)) == '该操作已处理或已失效（操作人：小李）'
    assert store.rows['channel_button_actions'][card.id]['clicked_by']['user_name'] == '小李'
    await bus.publish(event('workstep.review_result', review_run_id='review', status='awaiting_review'))
    await bus.publish(event('workstep.review_status', review_run_id='review', status='awaiting_review'))
    await asyncio.sleep(.03)
    assert adapter.send_card.await_count == 2


@pytest.mark.parametrize('change', ['archive','decided','newer','rebind'])
async def test_stale_review_card_cannot_decide(setup, change):
    relay,bus,event,adapter,controls,runtime,projects,project,data,_ = setup
    await bus.publish(event('workstep.review_result', review_run_id='review', status='awaiting_review'))
    await until(lambda: adapter.send_card.await_count == 2)
    recipient,card = adapter.send_card.await_args_list[0].args
    def alter(_project):
        if change == 'archive': Task.update(archived=True).where(Task.id=='task').execute()
        elif change == 'decided': ReviewRun.update(decision='approve',status='passed').where(ReviewRun.id=='review').execute()
        elif change == 'newer':
            ReviewRun.create(id='new', workflow_run='run', step_run='step', task='task',step_key='build',
                attempt=2,mode='manual',status='pending',started_at='2026-10-05')
    await projects.run_db(project.id, alter)
    if change == 'rebind': data['groups'] = []
    result = await controls.handle(ChannelAction('bot',card.id,'0','member',conversation_id=recipient.conversation_id))
    assert '失效' in result
    runtime.decide_review.assert_not_awaited()


async def test_automatic_question_answers_original_waiter_without_stop_and_expires(setup):
    relay,bus,event,adapter,controls,*_ = setup
    request = {'interaction_id':'interaction','method':'elicitation/create','message':'是否继续？',
        'requested_schema':{'properties':{'continue':{'type':'boolean'}}}}
    waiter = asyncio.create_task(intervention_manager.request_response('interaction','task','build',request))
    await asyncio.sleep(0)
    try:
        await bus.publish(event('workstep.interaction_request', **request))
        await until(lambda: adapter.send_card.await_count == 2)
        recipient,card = adapter.send_card.await_args_list[0].args
        assert [b.label for b in card.buttons] == ['是','否','取消']
        assert await controls.handle(ChannelAction('bot',card.id,'0','member',conversation_id=recipient.conversation_id)) == '已选择：是'
        assert await waiter == {'action':'accept','content':{'continue':True}}
        await bus.publish(event('workstep.interaction_response',interaction_id='interaction'))
        await bus.publish({**event(''), 'type':'TEXT_MESSAGE_END'})
        await until(lambda: not relay._scopes)
    finally:
        intervention_manager.cancel('interaction')
        await waiter


@pytest.mark.parametrize('key, decision, status', [('0','approve','passed'), ('1','reject','retrying')])
async def test_review_callback_persists_reviewer_and_message_author_after_restart(setup, key, decision, status):
    from services.workflow_runtime import WorkflowRuntime
    relay,bus,event,adapter,controls,_,projects,project,_,store = setup
    runtime = WorkflowRuntime(bus, projects)
    runtime._resume_in_project = AsyncMock()
    await bus.publish(event('workstep.review_result',review_run_id='review',status='awaiting_review'))
    await until(lambda: adapter.send_card.await_count == 2)
    recipient,card = adapter.send_card.await_args_list[0].args
    # Persisted manual review controls do not depend on in-memory active scopes.
    fresh = ChannelControls(store, controls._load_config, controls._adapters, SimpleNamespace(),
        SimpleNamespace(), AsyncMock(), workflow_runtime=runtime, projects=projects)
    await fresh.handle(ChannelAction('bot',card.id,key,'reviewer',conversation_id=recipient.conversation_id,sender_name='小陈'))
    def read(_project):
        review = ReviewRun.get_by_id('review')
        message = Message.get_by_id('review-message')
        step = TaskStep.get(TaskStep.task=='task')
        return review.decision, review.reviewer_id, review.reviewer_name, message.author_name, message.author_username, step.status
    assert await projects.run_db(project.id, read) == (decision,'channel:wecom:reviewer','企业微信 · 小陈','企业微信 · 小陈','reviewer',status)
    runtime._resume_in_project.assert_awaited_once()
    assert '失效' in await fresh.handle(ChannelAction('bot',card.id,key,'reviewer',conversation_id=recipient.conversation_id))


async def test_review_slow_sql_does_not_block_health_and_cross_group_clicks_submit_once(setup, monkeypatch):
    import threading
    from httpx import ASGITransport, AsyncClient
    import main
    relay,bus,event,adapter,controls,runtime,projects,project,*_ = setup
    await bus.publish(event('workstep.review_result',review_run_id='review',status='awaiting_review'))
    await until(lambda: adapter.send_card.await_count == 2)
    entered, release = threading.Event(), threading.Event()
    execute = project.db.execute_sql
    def slow(sql, *args, **kwargs):
        if sql.startswith('SELECT') and 'FROM "tasks"' in sql:
            entered.set()
            assert release.wait(2)
        return execute(sql, *args, **kwargs)
    monkeypatch.setattr(project.db, 'execute_sql', slow)
    recipient,card = adapter.send_card.await_args_list[0].args
    pending = asyncio.create_task(controls.handle(ChannelAction('bot',card.id,'0','member',conversation_id=recipient.conversation_id)))
    try:
        await until(entered.is_set)
        other_recipient,other = adapter.send_card.await_args_list[1].args
        assert '失效' in await controls.handle(ChannelAction('bot',other.id,'1','other',conversation_id=other_recipient.conversation_id))
        async with AsyncClient(transport=ASGITransport(app=main.app),base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
        assert not pending.done()
    finally:
        release.set()
        await pending
    assert runtime.decide_review.await_count == 1


async def test_wecom_review_callback_from_group_member_persists_source_user(setup, monkeypatch):
    from services.channels.wecom import WeComAdapter
    from services.workflow_runtime import WorkflowRuntime
    relay,bus,event,_,controls,_,projects,project,*_ = setup
    runtime = WorkflowRuntime(bus, projects)
    runtime._resume_in_project = AsyncMock()
    controls._workflow_runtime = runtime
    client = SimpleNamespace(connect=AsyncMock(),send_message=AsyncMock(),update_template_card=AsyncMock(),disconnect=lambda: None)
    handlers = {}
    def on(name):
        def register(handler):
            handlers[name] = handler
            return handler
        return register
    client.on = on
    monkeypatch.setattr('services.channels.wecom.WSClient', lambda options: client)
    adapter = WeComAdapter({'id':'bot','app_id':'bot','secret':'test'}, AsyncMock(), AsyncMock())
    adapter.set_action_handler(controls.handle)
    controls._adapters['bot'] = adapter
    await adapter.start()
    try:
        await bus.publish(event('workstep.review_result',review_run_id='review',status='awaiting_review'))
        await until(lambda: client.send_message.await_count == 2)
        group,payload = client.send_message.await_args_list[0].args
        card_id = payload['template_card']['task_id']
        await handlers['event.template_card_event']({'headers':{'req_id':'callback'},'body':{
            'chatid':group,'chattype':'group','from':{'userid':'XieZhaoRong'},
            'event':{'eventtype':'template_card_event','template_card_event':{'task_id':card_id,'event_key':'0'}}}})
        client.update_template_card.assert_awaited_once()
        def read(_project):
            row = ReviewRun.get_by_id('review')
            return row.reviewer_id, row.reviewer_name, row.decision
        assert await projects.run_db(project.id, read) == ('channel:wecom:XieZhaoRong','企业微信 · XieZhaoRong','approve')
        assert client.send_message.await_args.args[1]['markdown']['content'] == 'XieZhaoRong 审核通过'
    finally:
        await adapter.stop()


async def test_manual_review_card_waits_for_execution_delivery(setup):
    from services.channels.task_forwarder import ChannelTaskForwarder
    relay, bus, event, adapter, controls, _, projects, project, data, _ = setup
    entered, release = asyncio.Event(), asyncio.Event()
    order = []
    async def send_text(recipient, text):
        entered.set()
        await release.wait()
        order.append((recipient.conversation_id, 'text'))
    async def send_card(recipient, card):
        order.append((recipient.conversation_id, 'card'))
    adapter.send_text = AsyncMock(side_effect=send_text)
    adapter.send_card.side_effect = send_card
    forwarder = ChannelTaskForwarder(bus, projects, controls._load_config, {'bot': adapter})
    relay._forwarder = forwarder
    await forwarder.start()
    try:
        await bus.publish({'type': 'TEXT_MESSAGE_END', 'project_id': project.id,
            'task_id': 'task', 'messageId': 'message', 'status': 'completed', 'content': '执行正文'})
        await entered.wait()
        await bus.publish(event('workstep.review_result', review_run_id='review', status='awaiting_review'))
        await asyncio.sleep(.05)
        adapter.send_card.assert_not_awaited()
        release.set()
        await until(lambda: adapter.send_card.await_count == 2)
        for group in ('one', 'two'):
            assert [kind for dest, kind in order if dest == group] == ['text', 'card']
    finally:
        release.set()
        await forwarder.shutdown()


async def test_manual_review_lookup_after_author_change_keeps_health_responsive(setup, monkeypatch):
    import json
    import threading
    from httpx import ASGITransport, AsyncClient
    import main
    from services.channels.task_forwarder import ChannelTaskForwarder
    _, bus, _, adapter, controls, _, projects, project, *_ = setup
    await projects.run_db(project.id, lambda _p: Message.update(
        author_type='user', events_json=json.dumps([
            {'type': 'review_context', 'data': {'review_run_id': 'review'}},
        ]),
    ).where(Message.id == 'review-message').execute())
    entered, release = threading.Event(), threading.Event()
    original = ReviewRun.get_or_none
    def slow(*args, **kwargs):
        entered.set()
        assert release.wait(2)
        return original(*args, **kwargs)
    monkeypatch.setattr(ReviewRun, 'get_or_none', slow)
    adapter.send_text = AsyncMock()
    forwarder = ChannelTaskForwarder(bus, projects, controls._load_config, {'bot': adapter})
    await forwarder.start()
    try:
        await bus.publish({'type': 'TEXT_MESSAGE_END', 'project_id': project.id,
            'task_id': 'task', 'messageId': 'review-message', 'status': 'completed', 'content': '等待你审核'})
        assert await asyncio.to_thread(entered.wait, 1)
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'), .3)).status_code == 200
        release.set()
        await until(lambda: bool(forwarder._completed))
        adapter.send_text.assert_not_awaited()
    finally:
        release.set()
        await forwarder.shutdown()
