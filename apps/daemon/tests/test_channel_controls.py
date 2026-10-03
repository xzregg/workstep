"""Channel cards resume the original runtime without entering its message queue."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from services.channels.base import IncomingMessage, ChannelAction
from services.channels.controls import ChannelControls
from services.intervention import intervention_manager

class Store:
    def __init__(self): self.rows = {}
    def get(self, key, default=None): return self.rows.get(key, default)
    def set(self, key, value): self.rows[key] = value

@pytest.fixture
async def controls():
    store = Store()
    adapter = SimpleNamespace(send_card=AsyncMock(), update_card=AsyncMock())
    coordinator = SimpleNamespace(stop_current=AsyncMock(return_value=True), confirm_action=AsyncMock(return_value={'status':'succeeded'}), cancel_action=AsyncMock(return_value={'status':'cancelled'}))
    config = {'bots':[{'id':'b','enabled':True,'platform':'wecom'}], 'groups':[{'bot_id':'b','group_id':'g','project_id':'p','task_id':'t'}], 'sessions':{}}
    broker = ChannelControls(store, AsyncMock(return_value=config), {'b':adapter}, coordinator, SimpleNamespace(stop=AsyncMock()), AsyncMock())
    message = IncomingMessage('b','m','group','g','u','开始', sender_name='小王')
    scope = await broker.begin(message,'p',task_id='t',assistant_message_id='a',turn_id='turn')
    yield broker, adapter, coordinator, message, scope, store, config

async def test_stop_is_scoped_to_original_message_and_old_card_cannot_stop_next_turn(controls):
    broker, adapter, coordinator, message, scope, *_ = controls
    card = adapter.send_card.await_args.args[1]
    assert [b.label for b in card.buttons] == ['停止']
    click = ChannelAction('b', card.id, card.buttons[0].key, 'u', conversation_id='g')
    assert await broker.handle(click) == '已停止'
    coordinator.stop_current.assert_awaited_once_with('p','t',expected_message_id='a')
    assert await broker.handle(click) == '该操作已处理或已失效'
    await broker.finish(scope)
    await broker.begin(message,'p',task_id='t',assistant_message_id='next',turn_id='next-turn')
    await broker.handle(click)
    assert coordinator.stop_current.await_count == 1

async def test_permission_callback_unblocks_original_waiter_and_rejects_other_user_or_group(controls):
    broker, adapter, _, _, scope, *_ = controls
    request = {'interaction_id':'i', 'method':'session/request_permission', 'options':[{'option_id':'allow','name':'允许一次'}]}
    waiter = asyncio.create_task(intervention_manager.request_response('i','turn','assistant',request))
    await asyncio.sleep(0)
    try:
        await broker.event(scope, {'type':'CUSTOM','name':'workstep.interaction_request','value':request})
        card = adapter.send_card.await_args.args[1]
        assert await broker.handle(ChannelAction('b',card.id,'0','intruder',conversation_id='g')) == '仅发起此消息的用户可以操作'
        assert await broker.handle(ChannelAction('b',card.id,'0','u',conversation_id='other')) == '该操作不属于此会话'
        assert not waiter.done()
        assert await broker.handle(ChannelAction('b',card.id,'0','u',conversation_id='g')) == '已选择：允许一次'
        assert await waiter == {'outcome':{'outcome':'selected','option_id':'allow'}}
    finally:
        intervention_manager.cancel('i')
        await waiter

async def test_proposal_survives_finish_and_restart_and_binding_change_expires_it(controls):
    broker, adapter, coordinator, _, scope, store, config = controls
    await broker.event(scope, {'type':'CUSTOM','name':'workstep.action_proposal','value':{'id':'proposal','status':'pending','impact':{'summary':'启动实现阶段'}}})
    card = adapter.send_card.await_args.args[1]
    await broker.finish(scope)
    fresh = ChannelControls(store, broker._load_config, broker._adapters, coordinator, broker._responder, broker._on_message)
    assert await fresh.handle(ChannelAction('b',card.id,'0','u',conversation_id='g')) == '已确认'
    coordinator.confirm_action.assert_awaited_once_with('p','t','proposal',f'channel-card:{card.id}')
    assert await fresh.handle(ChannelAction('b',card.id,'1','u',conversation_id='g')) == '该操作已处理或已失效'
    await broker.event(scope, {'type':'CUSTOM','name':'workstep.action_proposal','value':{'id':'other','status':'pending'}})
    card = adapter.send_card.await_args.args[1]
    config['groups'] = []
    assert await broker.handle(ChannelAction('b',card.id,'0','u',conversation_id='g')) == '渠道绑定已改变，该操作已失效'
    assert coordinator.confirm_action.await_count == 1

async def test_wecom_nested_callback_confirms_original_task_proposal(controls, monkeypatch):
    from services.channels.wecom import WeComAdapter
    broker, _, coordinator, _, scope, store, _ = controls
    client = SimpleNamespace(connect=AsyncMock(), send_message=AsyncMock(),
                             update_template_card=AsyncMock(), disconnect=lambda: None)
    handlers = {}
    def on(name):
        def register(handler):
            handlers[name] = handler
            return handler
        return register
    client.on = on
    monkeypatch.setattr('services.channels.wecom.WSClient', lambda options: client)
    adapter = WeComAdapter({'id':'b','app_id':'a','secret':'s'}, AsyncMock(), AsyncMock())
    adapter.set_action_handler(broker.handle)
    broker._adapters['b'] = adapter
    await adapter.start()
    try:
        await broker.event(scope, {'type':'CUSTOM','name':'workstep.action_proposal',
                                  'value':{'id':'proposal','status':'pending'}})
        card_id = client.send_message.await_args.args[1]['template_card']['task_id']
        await broker.finish(scope)
        frame = {'headers':{'req_id':'callback'}, 'body':{'chatid':'g','from':{'userid':'u'},
                 'event':{'eventtype':'template_card_event',
                          'template_card_event':{'task_id':card_id,'event_key':'0'}}}}
        await handlers['event.template_card_event'](frame)
        coordinator.confirm_action.assert_awaited_once_with('p','t','proposal',f'channel-card:{card_id}')
        assert store.rows['channel_button_actions'][card_id]['status'] == 'completed'
        assert client.send_message.await_args.args[1]['markdown']['content'] == '已确认'
        await handlers['event.template_card_event'](frame)
        assert coordinator.confirm_action.await_count == 1
    finally:
        await adapter.stop()

async def test_async_question_choice_routes_answer_to_same_coordinator_with_sender(controls):
    broker, adapter, _, _, scope, *_ = controls
    await broker.event(scope, {'type':'CUSTOM','name':'workstep.async_question','value':{'source_item_id':'q','questions':[{'title':'启动阶段？','options':['是','否']}]}})
    card = adapter.send_card.await_args.args[1]
    assert await broker.handle(ChannelAction('b',card.id,'0','u',conversation_id='g')) == '已选择：是'
    answer = broker._on_message.await_args.args[0]
    assert (answer.bot_id,answer.conversation_id,answer.sender_id,answer.text) == ('b','g','u','启动阶段？：是')

async def test_slow_platform_send_does_not_block_event_loop(controls):
    broker, adapter, _, _, scope, *_ = controls
    entered, release = asyncio.Event(), asyncio.Event()
    async def slow(*args): entered.set(); await release.wait()
    adapter.send_card.side_effect = slow
    pending = asyncio.create_task(broker.event(scope, {'type':'CUSTOM','name':'workstep.async_question','value':{'source_item_id':'q','questions':[{'title':'确认？','options':['是','否']}]}}))
    await entered.wait()
    try:
        await asyncio.wait_for(asyncio.sleep(.01), .2)
        assert not pending.done()
    finally:
        release.set()
        await pending


@pytest.mark.parametrize('selection, expected', [('0',True),('1',False),('2',None)])
async def test_boolean_elicitation_delivers_yes_no_or_cancel(controls, selection, expected):
    broker, adapter, _, _, scope, *_ = controls
    request = {'interaction_id':'bool','method':'elicitation/create','message':'启动阶段？',
               'requested_schema':{'properties':{'start':{'type':'boolean'}},'required':['start']}}
    waiter = asyncio.create_task(intervention_manager.request_response('bool','turn','assistant',request))
    await asyncio.sleep(0)
    try:
        await broker.event(scope,{'type':'CUSTOM','name':'workstep.interaction_request','value':request})
        card = adapter.send_card.await_args.args[1]
        assert [button.label for button in card.buttons] == ['是','否','取消']
        await broker.handle(ChannelAction('b',card.id,selection,'u'))
        assert await waiter == ({'action':'cancel'} if expected is None else {'action':'accept','content':{'start':expected}})
    finally:
        intervention_manager.cancel('bool'); await waiter

async def test_long_question_keeps_every_option_and_invalidates_sibling_cards(controls):
    broker, adapter, _, _, scope, *_ = controls
    before = adapter.send_card.await_count
    options = [str(i) for i in range(9)]
    await broker.event(scope,{'type':'CUSTOM','name':'workstep.async_question','value':{'source_item_id':'q','questions':[{'title':'选择','options':options}]}})
    cards = [call.args[1] for call in adapter.send_card.await_args_list[before:]]
    assert [button.label for card in cards for button in card.buttons] == options
    await broker.handle(ChannelAction('b',cards[1].id,'0','u'))
    assert await broker.handle(ChannelAction('b',cards[0].id,'0','u')) == '该操作已处理或已失效'
    assert broker._on_message.await_count == 1

async def test_finished_permission_card_cannot_answer_a_later_engine_request(controls):
    broker, adapter, _, _, scope, *_ = controls
    await broker.event(scope,{'type':'CUSTOM','name':'workstep.interaction_request','value':{'interaction_id':'stale','method':'session/request_permission','options':[{'option_id':'yes','name':'允许'}]}})
    card = adapter.send_card.await_args.args[1]
    await broker.finish(scope)
    assert await broker.handle(ChannelAction('b',card.id,'0','u')) == '该操作已处理或已失效'


async def test_split_question_concurrent_clicks_submit_only_one_answer(controls):
    broker, adapter, _, _, scope, *_ = controls
    before = adapter.send_card.await_count
    await broker.event(scope, {'type':'CUSTOM','name':'workstep.async_question','value':{'source_item_id':'q','questions':[{'title':'选择','options':[str(i) for i in range(7)]}]}})
    cards = [call.args[1] for call in adapter.send_card.await_args_list[before:]]
    entered, release = asyncio.Event(), asyncio.Event()
    async def answer(*args): entered.set(); await release.wait()
    broker._on_message.side_effect = answer
    first = asyncio.create_task(broker.handle(ChannelAction('b',cards[0].id,'0','u')))
    await entered.wait()
    try:
        assert await asyncio.wait_for(broker.handle(ChannelAction('b',cards[1].id,'0','u')), .2) == '该操作已处理或已失效'
        assert broker._on_message.await_count == 1
    finally:
        release.set(); await first

async def test_project_question_cannot_move_to_new_task_binding(controls):
    broker, adapter, _, message, _, _, config = controls
    config['bots'][0]['default_project_id'] = 'p'
    config['groups'] = []
    config['sessions']['b:group:g'] = 'session'
    scope = await broker.begin(message,'p',session_id='session',assistant_message_id='a',turn_id='turn')
    await broker.event(scope,{'type':'CUSTOM','name':'workstep.async_question','value':{'source_item_id':'q','questions':[{'title':'继续？','options':['是','否']}]}})
    card = adapter.send_card.await_args.args[1]
    config['groups'] = [{'bot_id':'b','group_id':'g','project_id':'p','task_id':'t'}]
    assert await broker.handle(ChannelAction('b',card.id,'0','u')) == '渠道绑定已改变，该操作已失效'
    broker._on_message.assert_not_awaited()
