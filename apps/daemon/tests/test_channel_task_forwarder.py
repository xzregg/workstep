"""Bound tasks broadcast visible LLM messages without blocking execution."""
import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

import main
from models.message import Message
from models.task import Task
from services.channels.base import IncomingMessage
from services.channels.bots import BotManager
from services.channels.task_forwarder import ChannelTaskForwarder
from services.project import ProjectManager
from streaming.bus import EventBus


async def until(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(.005)


@pytest.fixture
async def setup(tmp_path):
    projects = ProjectManager()
    project = projects.init_project(tmp_path / 'task-forward')
    project.workflows = [{'id':'workflow', 'steps':{'nodes':[
        {'id':1,'type':'a','title':'编写'}, {'id':2,'type':'b','title':'交付'},
    ]}}]
    def seed(_project):
        Task.create(id='task',title='任务',cwd=str(project.path),workflow_id='workflow',created_at='2026-10-03',updated_at='2026-10-03')
        for mid, step, channel, role in [('a','a','execution','assistant'),('b','b','execution','assistant'),
                                          ('review','a','review','assistant'),('coord','__coordinator__','coordinator','assistant'),
                                          ('user','a','execution','user')]:
            Message.create(id=mid,task='task',step_key=step,channel=channel,role=role,position=1,created_at='2026-10-03')
    await projects.run_db(project.id, seed)
    data = {'bots':[{'id':'bot','enabled':True,'platform':'dingtalk'}],
            'groups':[{'bot_id':'bot','group_id':g,'project_id':project.id,'task_id':'task'} for g in ['one','two']]}
    adapter = SimpleNamespace(send_text=AsyncMock())
    bus = EventBus()
    forwarder = ChannelTaskForwarder(bus,projects,AsyncMock(return_value=data),{'bot':adapter},interval=.02)
    await forwarder.start()
    def event(mid, kind, **extra):
        return {'type':kind,'project_id':project.id,'task_id':'task','messageId':mid,**extra}
    yield forwarder,bus,event,adapter,data,projects,project
    await forwarder.shutdown()
    assert not bus._subscribers
    projects.close_all()


async def test_nonstreaming_stages_send_one_complete_message_per_group(setup):
    forwarder,bus,event,adapter,*_ = setup
    await bus.publish(event('a','TEXT_MESSAGE_START'))
    await until(lambda: bool(forwarder._messages))
    await bus.publish(event('a','TEXT_MESSAGE_CHUNK',delta='部分正文'))
    await asyncio.sleep(.05)
    adapter.send_text.assert_not_awaited()
    await bus.publish(event('a','TEXT_MESSAGE_END',status='succeeded',content='部分正文完成'))
    await until(lambda: not forwarder._messages)
    await bus.publish(event('b','TEXT_MESSAGE_START'))
    await bus.publish(event('b','TEXT_MESSAGE_END',status='succeeded',content='交付内容'))
    await until(lambda: any('交付内容' in c.args[1] for c in adapter.send_text.await_args_list))
    await until(lambda: not forwarder._messages)
    for group in ['one','two']:
        texts = [c.args[1] for c in adapter.send_text.await_args_list if c.args[0].conversation_id == group]
        assert texts == ['@编写\n部分正文完成','@交付\n交付内容']
    count = adapter.send_text.await_count
    await bus.publish(event('a','TEXT_MESSAGE_END',status='succeeded',content='部分正文完成'))
    await bus.publish(event('user','TEXT_MESSAGE_START',role='user'))
    await bus.publish(event('a','REASONING_MESSAGE_CHUNK',delta='思考'))
    await asyncio.sleep(.03)
    assert adapter.send_text.await_count == count


async def test_unbind_and_failure_are_isolated_while_parallel_messages_finish(setup):
    forwarder,bus,event,adapter,data,*_ = setup
    await bus.publish(event('a','TEXT_MESSAGE_START'))
    await bus.publish(event('review','TEXT_MESSAGE_START'))
    await until(lambda: len(forwarder._messages) == 2)
    data['groups'] = data['groups'][:1]
    await bus.publish(event('a','TEXT_MESSAGE_END',status='stopped',content='已生成'))
    await bus.publish(event('review','TEXT_MESSAGE_END',status='failed',content='审核正文',error='引擎失败'))
    await until(lambda: not forwarder._messages)
    finals = [c for c in adapter.send_text.await_args_list if c.args[1] != '@编写\n正在执行…' and c.args[1] != '@编写 · 审核\n正在执行…']
    assert len(finals) == 2
    assert all(c.args[0].conversation_id == 'one' for c in finals)
    assert any(c.args[1] == '@编写\n已生成' for c in finals)
    assert any('@编写 · 审核\n审核正文\n\n执行失败：引擎失败' == c.args[1] for c in finals)


async def test_origin_stream_receives_one_final_and_other_group_receives_broadcast(setup):
    forwarder,bus,event,adapter,_,_,project = setup
    adapter.update_reply = AsyncMock()
    adapter.CAPABILITIES = SimpleNamespace(streaming=True)
    origin = IncomingMessage('bot','incoming','group','one','u','问题',reply_context={'headers':{'req_id':'req'}})
    forwarder.register_origin(project.id,'task','coord',origin)
    await bus.publish(event('coord','TEXT_MESSAGE_START'))
    await bus.publish(event('coord','TEXT_MESSAGE_CHUNK',delta='协调回复'))
    await until(lambda: any(c.args[1] == '@协调\n协调回复' for c in adapter.update_reply.await_args_list))
    await bus.publish(event('coord','TEXT_MESSAGE_END',status='succeeded',content='协调回复完成'))
    await until(lambda: not forwarder._messages)
    origin_calls = [c for c in adapter.send_text.await_args_list if c.args[0].conversation_id == 'one']
    assert len(origin_calls) == 1
    assert origin_calls[0].args == (origin,'@协调\n协调回复完成')
    assert ('@协调\n协调回复') in [c.args[1] for c in adapter.update_reply.await_args_list]


@pytest.mark.parametrize('message_id,channel,title', [('a','execution','编写'), ('review','review','编写 · 审核')])
async def test_completed_status_from_real_message_translation_is_success(setup, message_id, channel, title):
    from engines.core.agui import to_agui_events, AGUIContext
    forwarder,bus,event,adapter,_,_,project = setup
    await bus.publish(event(message_id,'TEXT_MESSAGE_START',channel=channel))
    translated = to_agui_events({'type':'message_completed','data':{'status':'completed','content':'审核结果：通过。'}},
        AGUIContext(project_id=project.id,task_id='task',message_id=message_id,channel=channel))
    assert translated[0]['status'] == 'completed'
    await bus.publish(translated[0])
    await until(lambda: not forwarder._messages and adapter.send_text.await_count == 2)
    assert all(c.args[1] == '@' + title + '\n审核结果：通过。' for c in adapter.send_text.await_args_list)


async def test_slow_database_and_slow_group_keep_health_and_other_group_responsive(setup,monkeypatch):
    forwarder,bus,event,adapter,_,_,_ = setup
    entered,release = threading.Event(),threading.Event()
    original = Message.get_or_none
    def slow(*args,**kwargs):
        entered.set()
        assert release.wait(2)
        return original(*args,**kwargs)
    monkeypatch.setattr(Message,'get_or_none',slow)
    network_entered,network_release = asyncio.Event(),asyncio.Event()
    async def send(recipient,text):
        if recipient.conversation_id == 'one':
            network_entered.set()
            await network_release.wait()
    adapter.send_text.side_effect = send
    try:
        await bus.publish(event('a','TEXT_MESSAGE_START'))
        assert await asyncio.to_thread(entered.wait,1)
        async with AsyncClient(transport=ASGITransport(app=main.app),base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'),.5)).status_code == 200
        release.set()
        await bus.publish(event('a','TEXT_MESSAGE_END',status='succeeded',content='结果'))
        await asyncio.wait_for(network_entered.wait(),1)
        await until(lambda: any(c.args[0].conversation_id == 'two' for c in adapter.send_text.await_args_list))
        await until(lambda: any(c.args[0].conversation_id == 'two' and '结果' in c.args[1] for c in adapter.send_text.await_args_list))
    finally:
        release.set()
        network_release.set()
    await until(lambda: not forwarder._messages)


async def test_manager_routes_inbound_task_reply_once_and_keeps_button_controls(setup):
    forwarder,bus,event,adapter,data,projects,project = setup
    await forwarder.shutdown()
    bot = data['bots'][0]
    bot.update(default_target_type='project',default_project_id=project.id,default_task_id='')
    values = {'channel_bots':data}
    store = SimpleNamespace(get=lambda key,default=None:values.get(key,default),set=lambda key,value:values.__setitem__(key,value))
    async def submit(*args,**kwargs):
        async def produce():
            await bus.publish(event('coord','TEXT_MESSAGE_START',channel='coordinator'))
            await bus.publish(event('coord','CUSTOM',channel='coordinator',name='workstep.action_proposal',
                                    value={'id':'proposal','status':'pending'}))
            await bus.publish(event('coord','TEXT_MESSAGE_END',channel='coordinator',status='succeeded',content='协调回复'))
        asyncio.create_task(produce())
        return SimpleNamespace(assistant_message_id='coord',turn_id='turn')
    adapter.send_card = AsyncMock()
    adapter.update_card = AsyncMock()
    adapter.start = AsyncMock()
    adapter.stop = AsyncMock()
    coordinator = SimpleNamespace(submit_message=submit,confirm_action=AsyncMock())
    manager = BotManager(store,projects,bus,coordinator,AsyncMock(),
                         adapter_factories={'dingtalk':lambda *args:adapter})
    try:
        await manager.start()
        await manager.handle_message(IncomingMessage('bot','incoming','group','one','u','开始'))
        await until(lambda: any('协调回复' in c.args[1] for c in adapter.send_text.await_args_list))
        for group in ['one','two']:
            finals = [c for c in adapter.send_text.await_args_list if c.args[0].conversation_id == group and '协调回复' in c.args[1]]
            assert len(finals) == 1
            assert finals[0].args[1] == '@协调\n协调回复'
        from services.channels.base import ChannelAction
        card = next(call.args[1] for call in adapter.send_card.await_args_list if call.args[1].title == '请确认操作')
        assert await manager._handle_card_action(ChannelAction('bot',card.id,'0','u',conversation_id='one')) == '已确认'
        coordinator.confirm_action.assert_awaited_once_with(project.id,'task','proposal',f'channel-card:{card.id}')
    finally:
        await manager.shutdown()


async def test_retried_message_id_is_forwarded_again_and_duplicate_chunks_are_ignored(setup):
    forwarder,bus,event,adapter,*_ = setup
    await bus.publish(event('a','TEXT_MESSAGE_START',sequence=0))
    await until(lambda: bool(forwarder._messages))
    await bus.publish(event('a','TEXT_MESSAGE_CHUNK',delta='正文',sequence=1))
    await bus.publish(event('a','TEXT_MESSAGE_CHUNK',delta='正文',sequence=1))
    await asyncio.sleep(.05)
    adapter.send_text.assert_not_awaited()
    await bus.publish(event('a','TEXT_MESSAGE_END',status='failed',content='正文',sequence=2))
    await until(lambda: not forwarder._messages)
    await bus.publish(event('a','TEXT_MESSAGE_START',retry=True,sequence=0))
    await until(lambda: bool(forwarder._messages))
    await bus.publish(event('a','TEXT_MESSAGE_END',status='succeeded',content='重试结果',sequence=1))
    await until(lambda: not forwarder._messages)
    assert adapter.send_text.await_count == 4
    assert adapter.send_text.await_args.args[1] == '@编写\n重试结果'


async def test_final_loads_persisted_body_and_sends_project_attachments_once(setup):
    from services.channels.base import ChannelAdapter, ChannelCapabilities
    forwarder,bus,event,_,data,projects,project = setup
    class Adapter(ChannelAdapter):
        CHANNEL_ID = 'test'
        CAPABILITIES = ChannelCapabilities(send=frozenset({'text','image','file'}))
        async def start(self): pass
        async def stop(self): pass
        async def send(self,recipient,message): pass
    adapter = Adapter({'id':'bot'},AsyncMock(),AsyncMock())
    adapter.send = AsyncMock()
    forwarder._adapters['bot'] = adapter
    data['groups'] = data['groups'][:1]
    uploads = project.workstep_dir / 'uploads'
    uploads.mkdir(exist_ok=True)
    (uploads / 'test.png').write_bytes(b'image')
    (uploads / 'test.txt').write_bytes(b'file')
    body = '结果 ![图片](.workstep/uploads/test.png) [文件](.workstep/uploads/test.txt)'
    await projects.run_db(project.id,lambda _project: Message.update(content=body).where(Message.id == 'a').execute())
    await bus.publish(event('a','TEXT_MESSAGE_START'))
    await until(lambda: bool(forwarder._messages))
    await bus.publish(event('a','TEXT_MESSAGE_END',status='succeeded'))
    await until(lambda: not forwarder._messages)
    final = adapter.send.await_args.args[1]
    assert final.text == '@编写\n结果 图片 文件'
    assert [(a.kind,a.data) for a in final.attachments] == [('image',b'image'),('file',b'file')]
    assert adapter.send.await_count == 1


async def test_failed_progress_still_retries_final_without_affecting_other_group(setup):
    forwarder,bus,event,adapter,*_ = setup
    adapter.supports_streaming_reply = lambda recipient: True
    adapter.update_reply = AsyncMock()
    failed = False
    async def send(recipient,text):
        nonlocal failed
        if recipient.conversation_id == 'one' and not failed:
            failed = True
            raise RuntimeError('temporary connection error')
    adapter.update_reply.side_effect = send
    await bus.publish(event('a','TEXT_MESSAGE_START'))
    await until(lambda: adapter.update_reply.await_count == 2)
    await bus.publish(event('a','TEXT_MESSAGE_END',status='succeeded',content='最终结果'))
    await until(lambda: not forwarder._messages)
    assert {c.args[0].conversation_id for c in adapter.send_text.await_args_list if '最终结果' in c.args[1]} == {'one','two'}


async def test_proactive_dingtalk_updates_same_card_in_each_group(setup):
    from services.channels.dingtalk import DingTalkAdapter
    forwarder,bus,event,_,_,_,_ = setup
    adapter = DingTalkAdapter({'id':'bot','app_id':'client','secret':'secret'}, AsyncMock(), AsyncMock())
    adapter._card_api = AsyncMock(return_value={})
    adapter._send_text = AsyncMock()
    forwarder._adapters['bot'] = adapter
    await bus.publish(event('a','TEXT_MESSAGE_START'))
    await until(lambda: adapter._card_api.await_count == 2)
    await bus.publish(event('a','TEXT_MESSAGE_CHUNK',delta='部分'))
    await until(lambda: adapter._card_api.await_count == 4)
    await bus.publish(event('a','TEXT_MESSAGE_CHUNK',delta='正文'))
    await until(lambda: adapter._card_api.await_count == 6)
    await bus.publish(event('a','TEXT_MESSAGE_END',status='succeeded',content='完整正文'))
    await until(lambda: not forwarder._messages)
    calls = adapter._card_api.await_args_list
    creates = [c for c in calls if c.args[0] == 'POST']
    assert len(creates) == 2
    for created in creates:
        card_id = created.args[1]['outTrackId']
        updates = [c for c in calls if c.args[0] == 'PUT' and c.args[1]['outTrackId'] == card_id]
        assert [c.args[1]['cardData']['cardParamMap']['markdown'] for c in updates] == [
            '@编写\n部分', '@编写\n部分正文', '@编写\n完整正文']
    adapter._send_text.assert_not_awaited()
    assert not adapter._reply_cards


@pytest.mark.parametrize('message_id,channel', [('a','execution'), ('review','review'), ('coord','coordinator')])
async def test_automatic_task_broadcast_does_not_send_stop_buttons(setup, message_id, channel):
    from services.channels.controls import ChannelControls
    forwarder,bus,event,adapter,data,_,_ = setup
    values={}
    store=SimpleNamespace(get=lambda key,default=None:values.get(key,default),set=lambda key,value:values.__setitem__(key,value))
    runtime=SimpleNamespace(cancel_message=AsyncMock(return_value=True))
    adapter.send_card=AsyncMock()
    adapter.update_card=AsyncMock()
    adapter.supports_streaming_reply=lambda recipient:True
    adapter.update_reply=AsyncMock()
    controls=ChannelControls(store,forwarder._load,forwarder._adapters,SimpleNamespace(),SimpleNamespace(),AsyncMock(),workflow_runtime=runtime)
    forwarder._controls=controls
    await bus.publish(event(message_id,'TEXT_MESSAGE_START',channel=channel))
    await until(lambda:adapter.update_reply.await_count==2)
    adapter.send_card.assert_not_awaited()
    await bus.publish(event(message_id,'TEXT_MESSAGE_END',channel=channel,status='succeeded',content='完整正文'))
    await until(lambda:not forwarder._messages)
    assert not controls._active
    adapter.send_card.assert_not_awaited()
    runtime.cancel_message.assert_not_awaited()
    assert adapter.send_text.await_count==2


async def test_stop_engine_error_does_not_send_failure_after_stopped_final(setup):
    forwarder,bus,event,adapter,data,projects,project=setup
    await forwarder.shutdown()
    bot=data['bots'][0]
    bot.update(default_target_type='project',default_project_id=project.id,default_task_id='')
    values={'channel_bots':data}
    store=SimpleNamespace(get=lambda key,default=None:values.get(key,default),set=lambda key,value:values.__setitem__(key,value))
    async def submit(*args,**kwargs):
        async def produce():
            await bus.publish(event('coord','TEXT_MESSAGE_START',channel='coordinator'))
            await bus.publish(event('coord','RUN_ERROR',channel='coordinator',status='cancelled'))
            await bus.publish(event('coord','TEXT_MESSAGE_END',channel='coordinator',status='stopped',content=''))
        asyncio.create_task(produce())
        return SimpleNamespace(assistant_message_id='coord',turn_id='turn')
    adapter.send_card=AsyncMock()
    adapter.update_card=AsyncMock()
    adapter.start=AsyncMock()
    adapter.stop=AsyncMock()
    manager=BotManager(store,projects,bus,SimpleNamespace(submit_message=submit),AsyncMock(),adapter_factories={'dingtalk':lambda *args:adapter})
    try:
        await manager.start()
        await manager.handle_message(IncomingMessage('bot','incoming','group','one','u','继续'))
        await until(lambda:not manager._task_forwarder._messages)
        texts=[c.args[1] for c in adapter.send_text.await_args_list]
        assert texts.count('@协调\n已中止')==2
        assert not any('处理失败' in text for text in texts)
    finally:
        await manager.shutdown()


async def test_final_delivery_keeps_terminal_event_order_despite_slow_metadata(setup):
    forwarder, bus, event, adapter, *_ = setup
    entered, release = asyncio.Event(), asyncio.Event()
    original = forwarder._metadata
    async def delayed(state):
        if state.key[2] == 'a':
            entered.set()
            await release.wait()
        return await original(state)
    forwarder._metadata = delayed
    await bus.publish(event('a', 'TEXT_MESSAGE_END', status='completed', content='执行正文'))
    await entered.wait()
    await bus.publish(event('review', 'TEXT_MESSAGE_END', status='completed', content='自动审核正文'))
    try:
        await asyncio.sleep(.05)
        adapter.send_text.assert_not_awaited()
    finally:
        release.set()
    await until(lambda: not forwarder._messages)
    for group in ('one', 'two'):
        texts = [call.args[1] for call in adapter.send_text.await_args_list if call.args[0].conversation_id == group]
        assert texts == ['@编写\n执行正文', '@编写 · 审核\n自动审核正文']


async def test_manual_review_system_notice_is_not_forwarded_as_completed_llm(setup):
    forwarder, bus, event, adapter, _, projects, project = setup
    await projects.run_db(project.id, lambda _p: Message.update(
        author_type='system', content='等待你审核',
    ).where(Message.id == 'review').execute())
    await bus.publish(event('review', 'TEXT_MESSAGE_START', content='等待你审核'))
    await bus.publish(event('review', 'TEXT_MESSAGE_END', status='completed', content='等待你审核'))
    await until(lambda: bool(forwarder._completed))
    adapter.send_text.assert_not_awaited()


@pytest.mark.parametrize('status', ['succeeded', 'completed', 'stopped', 'cancelled'])
async def test_only_failures_append_status_to_channel_body(setup, status):
    forwarder, bus, event, adapter, *_ = setup
    await bus.publish(event('a', 'TEXT_MESSAGE_END', status=status, content='正文'))
    await until(lambda: bool(forwarder._completed))
    assert all(c.args[1] == '@编写\n正文' for c in adapter.send_text.await_args_list)


async def test_shutdown_cancels_ordered_delivery_without_hanging(setup):
    forwarder, bus, event, adapter, *_ = setup
    entered = asyncio.Event()
    async def slow(*_args):
        entered.set()
        await asyncio.Event().wait()
    adapter.send_text.side_effect = slow
    await bus.publish(event('a', 'TEXT_MESSAGE_END', status='completed', content='正文'))
    await entered.wait()
    await bus.publish(event('review', 'TEXT_MESSAGE_END', status='completed', content='审核正文'))
    await until(lambda: len(forwarder._messages) == 2)
    await asyncio.wait_for(forwarder.shutdown(), .5)
