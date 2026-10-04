"""Platform frame contracts without live enterprise credentials."""

import asyncio
import json
from unittest.mock import AsyncMock

import pytest

from services.channels.bots import IncomingMessage
from services.channels.dingtalk import DingTalkAdapter
from services.channels.wecom import WeComAdapter


@pytest.mark.asyncio
async def test_wecom_group_message_and_reply_use_official_sdk_frame(monkeypatch):
    class FakeClient:
        def __init__(self, options):
            self.handlers = {}
            self.connect = AsyncMock()
            self.send_message = AsyncMock()
            self.reply_stream = AsyncMock()
            self.reply_stream_with_card = AsyncMock()
            self.disconnect = lambda: None

        def on(self, event):
            def register(handler):
                self.handlers[event] = handler
                return handler
            return register

    instances = []

    def factory(options):
        client = FakeClient(options)
        instances.append(client)
        return client

    monkeypatch.setattr("services.channels.wecom.WSClient", factory)
    incoming = []
    adapter = WeComAdapter(
        {"id": "bot", "app_id": "platform-bot", "secret": "secret"},
        lambda message: _append(incoming, message), AsyncMock(),
    )
    await adapter.start()
    client = instances[0]
    await client.handlers["message.text"]({"headers": {"req_id": "callback-1"}, "body": {
        "msgid": "m1", "chattype": "group", "chatid": "room-1",
        "from": {"userid": "u1"}, "text": {"content": "请处理"},
    }})
    assert (incoming[0].conversation_id, incoming[0].sender_id, incoming[0].text) == ("room-1", "u1", "请处理")
    await adapter.start_reply(incoming[0])
    await adapter.send_text(incoming[0], "完成")
    first, last = client.reply_stream.await_args_list
    assert first.args[0] == incoming[0].reply_context
    assert first.args[1] == last.args[1]
    assert first.args[2] == "正在处理…"
    assert first.kwargs == {"finish": False}
    assert last.args[2] == "完成\n\n<@u1>"
    assert last.kwargs == {"finish": True}
    client.send_message.assert_not_awaited()
    await adapter.stop()


@pytest.mark.asyncio
async def test_wecom_retry_keeps_connection_error_visible(monkeypatch):
    class FakeClient:
        def __init__(self, _options):
            self.handlers = {}
            self.connect = AsyncMock()
            self.disconnect = lambda: None

        def on(self, event):
            def register(handler):
                self.handlers[event] = handler
                return handler
            return register

    clients = []

    def factory(options):
        client = FakeClient(options)
        clients.append(client)
        return client

    monkeypatch.setattr("services.channels.wecom.WSClient", factory)
    on_state = AsyncMock()
    adapter = WeComAdapter(
        {"id": "bot", "app_id": "platform-bot", "secret": "secret"},
        AsyncMock(), on_state,
    )
    await adapter.start()
    client = clients[0]
    reason = "connecting through a SOCKS proxy requires python-socks"
    await client.handlers["error"](RuntimeError(reason))
    await client.handlers["reconnecting"](1)
    assert on_state.await_args_list[-1].args == ("reconnecting", reason)
    await client.handlers["authenticated"]()
    assert on_state.await_args_list[-1].args == ("connected", "")
    await adapter.stop()


async def _append(rows, item):
    rows.append(item)


@pytest.mark.asyncio
async def test_dingtalk_stream_callback_ack_and_group_identity():
    incoming = []
    adapter = DingTalkAdapter(
        {"id": "bot", "app_id": "client", "secret": "secret"},
        lambda message: _append(incoming, message), AsyncMock(),
    )

    class FakeWebSocket:
        def __init__(self):
            self.sent = []

        async def send(self, value):
            self.sent.append(json.loads(value))

    socket = FakeWebSocket()
    adapter._client.websocket = socket
    adapter._client.pre_start()
    await adapter._client.route_message({
        "type": "CALLBACK",
        "headers": {"topic": "/v1.0/im/bot/messages/get", "messageId": "frame-1"},
        "data": json.dumps({
            "msgId": "m1", "msgtype": "text", "text": {"content": "请处理"},
            "conversationType": "2", "conversationId": "room-1",
            "senderStaffId": "u1", "senderNick": "张三",
            "sessionWebhook": "https://example.invalid/reply",
        }),
    })
    await asyncio.sleep(0)
    assert len(socket.sent) == 1
    assert socket.sent[0]["headers"]["messageId"] == "frame-1"
    assert (incoming[0].conversation_type, incoming[0].conversation_id, incoming[0].sender_name) == (
        "group", "room-1", "张三",
    )


async def test_wecom_final_reply_falls_back_to_active_send_if_stream_expires():
    adapter = WeComAdapter({"id": "bot"}, AsyncMock(), AsyncMock())
    client = type("Client", (), {
        "reply_stream": AsyncMock(side_effect=RuntimeError("stream expired")),
        "send_message": AsyncMock(),
    })()
    adapter._client = client
    message = IncomingMessage(
        bot_id="bot", message_id="m1", conversation_type="single",
        conversation_id="user", sender_id="user", text="hello",
        reply_context={"headers": {"req_id": "callback"}},
    )
    await adapter.send_text(message, "最终回答")
    client.send_message.assert_awaited_once_with("user", {
        "msgtype": "markdown", "markdown": {"content": "最终回答"},
    })


@pytest.mark.parametrize('conversation_type', ['single', 'group'])
async def test_dingtalk_active_reply_uses_official_recipient_and_cached_token(monkeypatch, conversation_type):
    calls = []
    entered, release = asyncio.Event(), asyncio.Event()
    class Response:
        def __init__(self, body): self.body = body
        async def __aenter__(self):
            if "accessToken" not in self.body:
                entered.set()
                await release.wait()
            return self
        async def __aexit__(self, *args): pass
        def raise_for_status(self): pass
        async def json(self): return self.body
    class Session:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        def post(self, url, **kwargs):
            calls.append((url, kwargs))
            return Response({'accessToken': 'token', 'expireIn': 7200} if url.endswith('/accessToken') else {'processQueryKey': 'sent'})
    monkeypatch.setattr('services.channels.dingtalk.aiohttp.ClientSession', Session)
    adapter = DingTalkAdapter({'id': 'bot', 'app_id': 'client', 'secret': 'secret'}, AsyncMock(), AsyncMock())
    message = IncomingMessage(bot_id='bot', message_id='local-answer', conversation_type=conversation_type,
                              conversation_id='chat-id', sender_id='staff-id', text='')
    pending = asyncio.create_task(adapter.send_text(message, '回复'))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        from httpx import AsyncClient, ASGITransport
        import main
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
    finally:
        release.set()
    await pending
    await adapter.send_text(message, '第二条')
    assert len(calls) == 3
    assert calls[0] == ('https://api.dingtalk.com/v1.0/oauth2/accessToken', {'json': {'appKey': 'client', 'appSecret': 'secret'}})
    url, request = calls[1]
    assert request['headers'] == {'x-acs-dingtalk-access-token': 'token'}
    assert request['json']['robotCode'] == 'client'
    assert request['json']['msgKey'] == 'sampleText'
    assert json.loads(request['json']['msgParam']) == {'content': '回复'}
    if conversation_type == 'group':
        assert url.endswith('/robot/groupMessages/send')
        assert request['json']['openConversationId'] == 'chat-id'
        assert 'userIds' not in request['json']
    else:
        assert url.endswith('/robot/oToMessages/batchSend')
        assert request['json']['userIds'] == ['staff-id']
        assert 'openConversationId' not in request['json']


async def test_wecom_local_reply_uses_active_send_without_old_callback():
    adapter = WeComAdapter({'id': 'bot'}, AsyncMock(), AsyncMock())
    adapter._client = type('Client', (), {'send_message': AsyncMock(), 'reply_stream': AsyncMock()})()
    message = IncomingMessage(bot_id='bot',message_id='local-answer',conversation_type='group',conversation_id='room',sender_id='user',text='')
    await adapter.send_text(message, '本地回复')
    adapter._client.send_message.assert_awaited_once_with('room', {'msgtype': 'markdown', 'markdown': {'content': '本地回复'}})
    adapter._client.reply_stream.assert_not_awaited()


@pytest.mark.parametrize('kind', ['image','file'])
async def test_wecom_media_callback_normalizes_attachment_without_downloading(monkeypatch, kind):
    class Client:
        def __init__(self, options): self.handlers={}
        def on(self,event):
            def register(handler): self.handlers[event]=handler; return handler
            return register
        connect=AsyncMock()
        disconnect=lambda self:None
    client=Client(None)
    monkeypatch.setattr('services.channels.wecom.WSClient',lambda options:client)
    incoming=[]
    adapter=WeComAdapter({'id':'b','app_id':'wx','secret':'secret'},lambda m:_append(incoming,m),AsyncMock())
    await adapter.start()
    try:
        await client.handlers['message.'+kind]({'headers':{'req_id':'req'},'body':{'msgid':'m','msgtype':kind,'from':{'userid':'u'},
            'chattype':'single',kind:{'url':'https://files.qq.com/a','aeskey':'key','filename':'name.pdf'}}})
        assert len(incoming)==1
        assert incoming[0].attachments[0].kind==kind
        assert incoming[0].attachments[0].reference['aeskey']=='key'
        assert incoming[0].text==''
    finally: await adapter.stop()


@pytest.mark.parametrize('kind', ['picture','file'])
async def test_dingtalk_media_callback_normalizes_download_code(kind):
    from services.channels.dingtalk import _MessageHandler
    messages=[]
    handler=_MessageHandler('b',lambda m:_append(messages,m))
    callback=type('Callback',(),{'data':{'msgtype':kind,'msgId':'m','conversationType':'1','conversationId':'chat','senderStaffId':'u',
        'content':{'downloadCode':'code','fileName':'report.pdf'},'robotCode':'robot'}})()
    await handler.process(callback)
    await asyncio.sleep(0)
    assert messages[0].attachments[0].kind==('image' if kind=='picture' else 'file')
    assert messages[0].attachments[0].reference=={'download_code':'code','robot_code':'robot'}


@pytest.mark.parametrize('kind', ['image','file'])
async def test_dingtalk_native_media_upload_and_send(monkeypatch, kind):
    from services.channels.base import ChannelAttachment,OutgoingMessage
    calls=[]
    class Response:
        def __init__(self,body):self.body=body
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        def raise_for_status(self):pass
        async def json(self):return self.body
    class Session:
        def __init__(self,**kwargs):pass
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        def post(self,url,**kwargs):
            calls.append((url,kwargs))
            body={'accessToken':'token','expireIn':7200} if url.endswith('/accessToken') else ({'media_id':'@media','errcode':0} if url.endswith('/media/upload') else {'processQueryKey':'sent'})
            return Response(body)
    monkeypatch.setattr('services.channels.dingtalk.aiohttp.ClientSession',Session)
    adapter=DingTalkAdapter({'id':'b','app_id':'ding','secret':'secret'},AsyncMock(),AsyncMock())
    attachment=ChannelAttachment(kind,'photo.png' if kind=='image' else 'report.pdf',data=b'media')
    await adapter.send(IncomingMessage('b','m','group','g','u',''),OutgoingMessage(attachments=(attachment,)))
    assert calls[1][1]['params']=={'access_token':'token','type':kind}
    body=calls[-1][1]['json']
    assert body['openConversationId']=='g'
    assert body['msgKey']==('sampleImageMsg' if kind=='image' else 'sampleFile')
    params=json.loads(body['msgParam'])
    assert params==({'photoURL':'@media'} if kind=='image' else {'mediaId':'@media','fileName':'report.pdf','fileType':'pdf'})


@pytest.mark.asyncio
async def test_dingtalk_received_group_name_and_sender_are_normalized():
    from types import SimpleNamespace
    from services.channels.dingtalk import _MessageHandler
    received = []
    done = asyncio.Event()
    async def accept(message):
        received.append(message)
        done.set()
    handler = _MessageHandler('bot', accept)
    await handler.process(SimpleNamespace(data={
        'msgId': 'm1', 'conversationType': '2', 'conversationId': 'room',
        'conversationTitle': '研发群', 'senderStaffId': 'u1', 'senderNick': '小王',
        'msgtype': 'text', 'text': {'content': '你好'},
    }))
    await asyncio.wait_for(done.wait(), 1)
    assert received[0].conversation_name == '研发群'
    assert received[0].sender_name == '小王'
    assert received[0].sender_id == 'u1'


@pytest.mark.parametrize('nested', [False, True])
@pytest.mark.parametrize('result', ['已停止', '该回复已结束', '操作失败，请重试', '该操作已处理或已失效（操作人：小王）'])
async def test_wecom_card_buttons_and_callback_use_original_card_id(monkeypatch, nested, result):
    from services.channels.base import ChannelCard, ChannelButton
    clients = []
    class Client:
        def __init__(self, options):
            self.handlers = {}; self.connect = AsyncMock(); self.send_message = AsyncMock()
            self.update_template_card = AsyncMock(); self.disconnect = lambda: None
            clients.append(self)
        def on(self, name):
            def register(fn): self.handlers[name] = fn; return fn
            return register
    monkeypatch.setattr('services.channels.wecom.WSClient', Client)
    adapter = WeComAdapter({'id':'b','app_id':'a','secret':'s'}, AsyncMock(), AsyncMock())
    received = []
    async def action(click, on_claimed=None):
        received.append(click)
        await on_claimed()
        return result
    adapter.set_action_handler(action)
    await adapter.start()
    client = clients[0]
    message = IncomingMessage('b','m','group','g','u','hi')
    await adapter.send_card(message, ChannelCard('card','处理中','请稍候',(ChannelButton('0','停止'),)))
    payload = client.send_message.await_args.args[1]
    assert payload['msgtype'] == 'template_card'
    assert payload['template_card']['task_id'] == 'card'
    assert payload['template_card']['button_list'] == [{'text':'停止','key':'0'}]
    details = {'task_id':'card','event_key':'0'}
    event = {'eventtype':'template_card_event', 'template_card_event':details} if nested else {'eventtype':'template_card_event', **details}
    frame = {'headers':{'req_id':'callback'}, 'body':{'chatid':'g','from':{'userid':'u'},'event':event}}
    await client.handlers['event.template_card_event'](frame)
    assert (received[0].card_id,received[0].key,received[0].sender_id) == ('card','0','u')
    client.update_template_card.assert_awaited_once()
    assert client.update_template_card.await_args.args[1]['task_id'] == 'card'
    # The original reply supplies the terminal "已停止" message. Other
    # outcomes still need explicit feedback from the button callback.
    assert client.send_message.await_count == (1 if result == '已停止' else 2)
    if result != '已停止':
        assert client.send_message.await_args.args[1]['markdown']['content'] == result
    await adapter.stop()

async def test_dingtalk_card_callback_ack_does_not_wait_for_llm_action():
    from services.channels.dingtalk import CARD_TOPIC
    from services.channels.base import ChannelCard, ChannelButton
    adapter = DingTalkAdapter({'id':'b','app_id':'a','secret':'s'}, AsyncMock(), AsyncMock())
    entered, release = asyncio.Event(), asyncio.Event()
    clicks = []
    async def action(click, on_claimed=None):
        clicks.append(click); entered.set(); await release.wait(); return '已停止'
    adapter.set_action_handler(action)
    adapter.update_card = AsyncMock()
    adapter._card_api = AsyncMock(return_value={})
    await adapter.send_card(IncomingMessage('b','m','group','g','u','hi'),ChannelCard('card','处理中','稍候',(ChannelButton('0','停止'),)))
    payload = adapter._card_api.await_args.args[1]
    assert payload['callbackType'] == 'STREAM'
    assert payload['outTrackId'] == 'card'
    assert payload['openSpaceId'] == 'dtv1.card//IM_GROUP.g'
    buttons = json.loads(payload['cardData']['cardParamMap']['sys_full_json_obj'])['msgButtons']
    assert buttons[0]['request'] is True and buttons[0]['id'] == '0'
    class Socket:
        def __init__(self): self.sent = []
        async def send(self, data): self.sent.append(json.loads(data))
    socket = Socket(); adapter._client.websocket = socket; adapter._client.pre_start()
    try:
        await asyncio.wait_for(adapter._client.route_message({'type':'CALLBACK','headers':{'topic':CARD_TOPIC,'messageId':'c'},'data':json.dumps({'outTrackId':'card','userId':'u','content':json.dumps({'cardPrivateData':{'actionIds':['0']}})})}), .5)
        assert socket.sent[0]['headers']['messageId'] == 'c'
        await asyncio.wait_for(entered.wait(), .5)
        assert clicks[0].card_id == 'card' and clicks[0].key == '0'
        release.set()
        await asyncio.sleep(.01)
    finally:
        release.set(); await adapter.stop()


async def test_dingtalk_card_http_is_async_and_checks_platform_error(monkeypatch):
    from services.channels.base import ChannelCard, ChannelButton
    adapter = DingTalkAdapter({'id':'b','app_id':'a','secret':'s'},AsyncMock(),AsyncMock())
    adapter._token = AsyncMock(return_value='token')
    entered, release = asyncio.Event(), asyncio.Event()
    calls = []
    result = {}
    class Response:
        async def __aenter__(self): entered.set(); await release.wait(); return self
        async def __aexit__(self,*args): pass
        def raise_for_status(self): pass
        async def json(self): return result
    class Session:
        def __init__(self,**kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self,*args): pass
        def request(self,method,url,**kwargs): calls.append((method,url,kwargs)); return Response()
    monkeypatch.setattr('services.channels.dingtalk.aiohttp.ClientSession',Session)
    card = ChannelCard('c','处理','等待',(ChannelButton('0','停止'),))
    pending = asyncio.create_task(adapter.send_card(IncomingMessage('b','m','single','u','u','开始'),card))
    await entered.wait()
    try:
        await asyncio.wait_for(asyncio.sleep(.01),.2)
        assert not pending.done()
    finally:
        release.set(); await pending
    assert calls[0][0:2] == ('POST','https://api.dingtalk.com/v1.0/card/instances/createAndDeliver')
    assert calls[0][2]['json']['openSpaceId'] == 'dtv1.card//IM_ROBOT.u'
    result.update(code='Forbidden')
    with pytest.raises(RuntimeError,match='卡片操作失败'):
        await adapter.update_card(None,card)


async def test_wecom_stop_card_is_sent_once_with_stream_updates():
    from services.channels.base import ChannelCard, ChannelButton
    adapter = WeComAdapter({'id':'b'},AsyncMock(),AsyncMock())
    client = type('Client',(),{'reply_stream':AsyncMock(),'reply_stream_with_card':AsyncMock(),'send_message':AsyncMock()})()
    adapter._client = client
    frame = {'headers':{'req_id':'request'}}
    message = IncomingMessage('b','m','group','g','u','开始',reply_context=frame)
    await adapter.start_reply(message)
    card = ChannelCard('c','正在处理','点击中止',(ChannelButton('0','中止'),), running=True)
    await adapter.send_card(message,card)
    await adapter.update_reply(message,'部分正文')
    await adapter.send_text(message,'已停止。')
    client.send_message.assert_awaited_once()
    client.reply_stream_with_card.assert_not_awaited()
    calls = client.reply_stream.await_args_list
    template=client.send_message.await_args.args[1]['template_card']
    assert template['task_id']=='c'
    # Active button cards require a title: the live API rejects its absence
    # with errcode=41016, errmsg="missing title".
    assert template['main_title']=={'title':'正在处理'}
    assert template['sub_title_text']=='点击中止'
    assert template['button_list']==[{'text':'中止','key':'0'}]
    assert [c.args[2] for c in calls]==['正在处理…','部分正文','已停止。\n\n<@u>']
    assert all('template_card' not in c.kwargs for c in calls)
    assert calls[-1].kwargs['finish'] is True



@pytest.mark.parametrize('title, expected', [('   ', '请选择操作'), ('阶段' * 20, '阶段' * 13)])
async def test_wecom_button_card_keeps_required_title_within_platform_limit(title, expected):
    from services.channels.base import ChannelCard, ChannelButton
    adapter = WeComAdapter({'id':'bot'}, AsyncMock(), AsyncMock())
    adapter._client = type('Client', (), {'send_message':AsyncMock()})()
    card = ChannelCard('card', title, '点击按钮操作。', (ChannelButton('0', '确认'),))
    await adapter.send_card(IncomingMessage('bot','m','group','group','u',''), card)
    template = adapter._client.send_message.await_args.args[1]['template_card']
    assert template['main_title'] == {'title':expected}
    assert template['sub_title_text'] == '点击按钮操作。'


async def test_wecom_long_choices_use_short_number_buttons_and_full_descriptions():
    from services.channels.base import ChannelCard, ChannelButton
    adapter=WeComAdapter({'id':'bot'},AsyncMock(),AsyncMock())
    adapter._client=type('Client',(),{'send_message':AsyncMock()})()
    choices=['复用原始任务输入','复用上一次阶段输入','我提供新的输入']
    card=ChannelCard('card','请选择','为额外阶段提供什么输入？',tuple(ChannelButton(str(i),label) for i,label in enumerate(choices)))
    await adapter.send_card(IncomingMessage('bot','m','group','group','u',''),card)
    template=adapter._client.send_message.await_args.args[1]['template_card']
    assert template['button_list']==[{'text':str(i+1),'key':str(i)} for i in range(3)]
    assert template['main_title']=={'title':'请选择'}
    assert template['sub_title_text']=='为额外阶段提供什么输入？\n\n1. 复用原始任务输入\n2. 复用上一次阶段输入\n3. 我提供新的输入'


async def test_wecom_oversized_choice_explanation_is_complete_and_does_not_end_reply_stream():
    from services.channels.base import ChannelCard, ChannelButton
    adapter=WeComAdapter({'id':'bot'},AsyncMock(),AsyncMock())
    adapter._client=type('Client',(),{'send_message':AsyncMock(),'reply_stream':AsyncMock()})()
    choices=['方案甲：'+ '具体说明'*40,'方案乙：'+ '另一说明'*40]
    card=ChannelCard('card','请选择','选择方案',tuple(ChannelButton(str(i),label) for i,label in enumerate(choices)))
    await adapter.send_card(IncomingMessage('bot','m','group','group','u','',reply_context={'headers':{'req_id':'req'}}),card)
    calls=adapter._client.send_message.await_args_list
    assert [c.args[1]['msgtype'] for c in calls]==['markdown','template_card']
    explanation=calls[0].args[1]['markdown']['content']
    assert all(label in explanation for label in choices)
    assert len(calls[1].args[1]['template_card']['sub_title_text'])<=112
    assert calls[1].args[1]['template_card']['main_title']=={'title':'请选择'}
    adapter._client.reply_stream.assert_not_awaited()
