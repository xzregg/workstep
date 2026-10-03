"""Enterprise WeChat AI bot over the official long-connection SDK."""

from __future__ import annotations

import asyncio
import logging
import uuid

from aibot import WSClient, WSClientOptions

from services.channels.base import ChannelAdapter, ChannelCapabilities, ChannelAttachment, IncomingMessage, OutgoingMessage
from services.channels.media import fetch_media


logger = logging.getLogger(__name__)


class WeComAdapter(ChannelAdapter):
    CHANNEL_ID = 'wecom'
    DISPLAY_NAME = '企业微信'
    CAPABILITIES = ChannelCapabilities(receive=frozenset({'text','image','file'}), send=frozenset({'text','image','file'}), waiting=True)

    def __init__(self, bot: dict, on_message, on_state):
        super().__init__(bot, on_message, on_state)
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

        @client.on("message.file")
        @client.on("message.image")
        @client.on("message.mixed")
        @client.on("message.text")
        async def text_message(frame):
            body = frame.get("body") or {}
            sender = body.get("from") or {}
            sender_id = str(sender.get("userid") or "")
            is_group = body.get("chattype") == "group"
            conversation_id = str(body.get("chatid") or "") if is_group else sender_id
            items = (body.get('mixed') or {}).get('msg_item', []) if body.get('msgtype') == 'mixed' else [body]
            attachments = []
            texts = []
            for item in items:
                kind = item.get('msgtype') or ('text' if item.get('text') else '')
                if kind == 'text':
                    texts.append(str((item.get('text') or {}).get('content') or ''))
                elif kind in {'image','file'}:
                    media = item.get(kind) or {}
                    attachments.append(ChannelAttachment(kind=kind, name=media.get('filename') or media.get('name') or '', reference=media))
            message = IncomingMessage(
                bot_id=self._bot["id"],
                message_id=str(body.get("msgid") or ""),
                conversation_type="group" if is_group else "single",
                conversation_id=conversation_id,
                sender_id=sender_id,
                sender_name=sender_id,
                text="\n".join(texts),
                attachments=tuple(attachments),
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

    def _stream_id(self, message: IncomingMessage) -> str:
        return uuid.uuid5(uuid.NAMESPACE_URL, f"workstep:wecom:{message.bot_id}:{message.message_id}").hex

    def _reply_frame(self, message: IncomingMessage) -> dict | None:
        frame = message.reply_context
        if isinstance(frame, dict) and (frame.get("headers") or {}).get("req_id"):
            return frame
        return None

    async def start_reply(self, message: IncomingMessage) -> None:
        if not self._client:
            raise RuntimeError("企业微信机器人未连接")
        frame = self._reply_frame(message)
        if frame:
            await self._client.reply_stream(frame, self._stream_id(message), "", finish=False)

    async def _send_text(self, message: IncomingMessage, text: str) -> None:
        if not self._client:
            raise RuntimeError("企业微信机器人未连接")
        frame = self._reply_frame(message)
        if frame:
            try:
                await self._client.reply_stream(frame, self._stream_id(message), text, finish=True)
                return
            except Exception:
                logger.warning("Enterprise WeChat stream reply failed; using active send", exc_info=True)
        await self._client.send_message(message.conversation_id, {
            "msgtype": "markdown", "markdown": {"content": text},
        })


    async def send(self, recipient: IncomingMessage, message: OutgoingMessage) -> None:
        self.validate_outgoing(message)
        if not self._client:
            raise RuntimeError("企业微信机器人未连接")
        # Upload every attachment before delivering any part of the message.
        from services.channels.wecom_media import upload_media
        media = [(attachment.kind, await upload_media(self._client, attachment)) for attachment in message.attachments]
        if message.text:
            await self._send_text(recipient, message.text)
        for kind, media_id in media:
            await self._client.send_message(recipient.conversation_id, {'msgtype':kind, kind:{'media_id':media_id}})

    async def download(self, attachment: ChannelAttachment) -> tuple[bytes, str]:
        reference = attachment.reference
        data = await fetch_media(reference.get('url') or '', self.CAPABILITIES.limit(attachment.kind) + 32, ('qq.com','qpic.cn','weixin.qq.com','myqcloud.com'))
        key = reference.get('aeskey')
        if key:
            from aibot.crypto_utils import decrypt_file
            data = await asyncio.to_thread(decrypt_file, data, key)
        return data, attachment.name
