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
    assert first.args[2] == ""
    assert first.kwargs == {"finish": False}
    assert last.args[2] == "完成"
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
