"""DingTalk Stream bot using official message types and an async connection loop."""

from __future__ import annotations

import asyncio
import json
import logging
from urllib.parse import quote_plus

import aiohttp
import websockets
from dingtalk_stream import AckMessage, ChatbotHandler, ChatbotMessage, Credential, DingTalkStreamClient

from services.channels.bots import IncomingMessage


logger = logging.getLogger(__name__)


class _MessageHandler(ChatbotHandler):
    def __init__(self, bot_id, on_message):
        super().__init__()
        self._bot_id = bot_id
        self._on_message = on_message

    async def process(self, callback):
        incoming = ChatbotMessage.from_dict(callback.data)
        if incoming.message_type == "text" and incoming.text is not None:
            is_group = incoming.conversation_type == "2"
            message = IncomingMessage(
                bot_id=self._bot_id,
                message_id=str(incoming.message_id or ""),
                conversation_type="group" if is_group else "single",
                conversation_id=str(incoming.conversation_id or incoming.sender_staff_id or incoming.sender_id or ""),
                sender_id=str(incoming.sender_staff_id or incoming.sender_id or ""),
                sender_name=str(incoming.sender_nick or ""),
                text=str(incoming.text.content or "").strip(),
                reply_context=incoming.session_webhook,
            )
            asyncio.create_task(self._on_message(message))
        return AckMessage.STATUS_OK, "OK"


class DingTalkAdapter:
    def __init__(self, bot: dict, on_message, on_state):
        self._bot = bot
        self._on_message = on_message
        self._on_state = on_state
        self._task: asyncio.Task | None = None
        self._client = DingTalkStreamClient(Credential(bot["app_id"], bot["secret"]))
        self._client.register_callback_handler(
            ChatbotMessage.TOPIC, _MessageHandler(bot["id"], on_message),
        )

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _run(self) -> None:
        self._client.pre_start()
        while True:
            try:
                timeout = aiohttp.ClientTimeout(total=10)
                async with aiohttp.ClientSession(timeout=timeout) as session:
                    async with session.post(self._client.OPEN_CONNECTION_API, json={
                        "clientId": self._bot["app_id"],
                        "clientSecret": self._bot["secret"],
                        "subscriptions": [{"type": "CALLBACK", "topic": ChatbotMessage.TOPIC}],
                        "ua": "workstep-dingtalk-stream",
                        "localIp": "",
                    }) as response:
                        response.raise_for_status()
                        connection = await response.json()
                uri = f'{connection["endpoint"]}?ticket={quote_plus(connection["ticket"])}'
                async with websockets.connect(uri, ping_interval=20, ping_timeout=20) as websocket:
                    self._client.websocket = websocket
                    await self._on_state("connected", "")
                    async for raw in websocket:
                        await self._client.route_message(json.loads(raw))
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("DingTalk bot connection failed")
                await self._on_state("reconnecting", "钉钉连接失败，正在重试")
            finally:
                self._client.websocket = None
            await asyncio.sleep(3)

    async def send_text(self, message: IncomingMessage, text: str) -> None:
        webhook = str(message.reply_context or "")
        if not webhook:
            raise RuntimeError("钉钉回复地址已失效")
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(webhook, json={
                "msgtype": "text", "text": {"content": text},
            }) as response:
                response.raise_for_status()
                body = await response.text()
                try:
                    result = json.loads(body) if body else {}
                except json.JSONDecodeError:
                    result = {}
                if isinstance(result, dict) and result.get("errcode") not in (None, 0):
                    raise RuntimeError("钉钉消息发送失败")
