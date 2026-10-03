"""Enterprise WeChat AI bot over the official long-connection SDK."""

from __future__ import annotations

import asyncio
import logging

from aibot import WSClient, WSClientOptions

from services.channels.bots import IncomingMessage


logger = logging.getLogger(__name__)


class WeComAdapter:
    def __init__(self, bot: dict, on_message, on_state):
        self._bot = bot
        self._on_message = on_message
        self._on_state = on_state
        self._client: WSClient | None = None
        self._task: asyncio.Task | None = None
        self._stopped = False
        self._last_error = ""

    async def start(self) -> None:
        self._stopped = False
        self._last_error = ""
        client = WSClient(WSClientOptions(
            bot_id=self._bot["app_id"], secret=self._bot["secret"],
            max_reconnect_attempts=-1,
        ))
        self._client = client

        @client.on("authenticated")
        async def authenticated():
            if not self._stopped:
                self._last_error = ""
                await self._on_state("connected", "")

        @client.on("reconnecting")
        async def reconnecting(_attempt):
            if not self._stopped:
                await self._on_state("reconnecting", self._last_error)

        @client.on("disconnected")
        async def disconnected(_reason):
            if not self._stopped:
                self._last_error = str(_reason or "")
                await self._on_state("reconnecting", self._last_error)

        @client.on("error")
        async def failed(_error):
            if not self._stopped:
                self._last_error = str(_error or "") or "企业微信连接失败"
                await self._on_state("error", self._last_error)

        @client.on("message.text")
        async def text_message(frame):
            body = frame.get("body") or {}
            sender = body.get("from") or {}
            sender_id = str(sender.get("userid") or "")
            is_group = body.get("chattype") == "group"
            conversation_id = str(body.get("chatid") or "") if is_group else sender_id
            message = IncomingMessage(
                bot_id=self._bot["id"],
                message_id=str(body.get("msgid") or ""),
                conversation_type="group" if is_group else "single",
                conversation_id=conversation_id,
                sender_id=sender_id,
                sender_name=sender_id,
                text=str((body.get("text") or {}).get("content") or ""),
                reply_context=frame,
            )
            await self._on_message(message)

        self._task = asyncio.create_task(self._connect(client))

    async def _connect(self, client: WSClient) -> None:
        try:
            await client.connect()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception("Enterprise WeChat bot connection failed")
            if not self._stopped:
                self._last_error = str(exc) or "企业微信连接失败"
                await self._on_state("error", self._last_error)

    async def stop(self) -> None:
        self._stopped = True
        if self._client:
            self._client.disconnect()
            self._client = None
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def send_text(self, message: IncomingMessage, text: str) -> None:
        if not self._client:
            raise RuntimeError("企业微信机器人未连接")
        await self._client.send_message(message.conversation_id, {
            "msgtype": "markdown", "markdown": {"content": text},
        })
