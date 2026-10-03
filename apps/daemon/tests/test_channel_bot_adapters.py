"""Platform frame contracts without live enterprise credentials."""

import asyncio
import json
from unittest.mock import AsyncMock

import pytest

from services.channels.dingtalk import DingTalkAdapter
from services.channels.wecom import WeComAdapter


@pytest.mark.asyncio
async def test_wecom_group_message_and_reply_use_official_sdk_frame(monkeypatch):
    class FakeClient:
        def __init__(self, options):
            self.handlers = {}
            self.connect = AsyncMock()
            self.send_message = AsyncMock()
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
    await client.handlers["message.text"]({"body": {
        "msgid": "m1", "chattype": "group", "chatid": "room-1",
        "from": {"userid": "u1"}, "text": {"content": "请处理"},
    }})
    assert (incoming[0].conversation_id, incoming[0].sender_id, incoming[0].text) == ("room-1", "u1", "请处理")
    await adapter.send_text(incoming[0], "完成")
    client.send_message.assert_awaited_once_with("room-1", {
        "msgtype": "markdown", "markdown": {"content": "完成"},
    })
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
