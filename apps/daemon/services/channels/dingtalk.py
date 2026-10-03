"""DingTalk Stream bot using official message types and an async connection loop."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from urllib.parse import quote_plus

import aiohttp
import websockets
from dingtalk_stream import AckMessage, ChatbotHandler, ChatbotMessage, Credential, DingTalkStreamClient

from services.channels.base import ChannelAdapter, ChannelCapabilities, ChannelAttachment, IncomingMessage, OutgoingMessage
from services.channels.media import fetch_media


logger = logging.getLogger(__name__)


class _MessageHandler(ChatbotHandler):
    def __init__(self, bot_id, on_message):
        super().__init__()
        self._bot_id = bot_id
        self._on_message = on_message

    async def process(self, callback):
        incoming = ChatbotMessage.from_dict(callback.data)
        raw = callback.data
        texts = []
        attachments = []
        if incoming.text is not None:
            texts.append(str(incoming.text.content or '').strip())
        kind = incoming.message_type
        items = (raw.get('content') or {}).get('richText', []) if kind == 'richText' else [raw.get('content') or raw.get('file') or {}]
        for item in items:
            if item.get('text'):
                texts.append(str(item['text']))
            code = item.get('downloadCode') or item.get('pictureDownloadCode')
            if code:
                media_kind = 'image' if kind in {'picture','richText'} and (kind == 'picture' or item.get('type') == 'picture' or item.get('pictureDownloadCode')) else 'file'
                attachments.append(ChannelAttachment(kind=media_kind, name=item.get('fileName') or '',
                    reference={'download_code':code, 'robot_code':incoming.robot_code}))
        if texts or attachments:
            is_group = incoming.conversation_type == "2"
            message = IncomingMessage(
                bot_id=self._bot_id,
                message_id=str(incoming.message_id or ""),
                conversation_type="group" if is_group else "single",
                conversation_id=str(incoming.conversation_id or incoming.sender_staff_id or incoming.sender_id or ""),
                sender_id=str(incoming.sender_staff_id or incoming.sender_id or ""),
                sender_name=str(incoming.sender_nick or ""),
                conversation_name=str(incoming.conversation_title or "") if is_group else "",
                text="\n".join(texts),
                attachments=tuple(attachments),
                reply_context=incoming.session_webhook,
            )
            asyncio.create_task(self._on_message(message))
        return AckMessage.STATUS_OK, "OK"


class DingTalkAdapter(ChannelAdapter):
    CHANNEL_ID = 'dingtalk'
    DISPLAY_NAME = '钉钉'
    CAPABILITIES = ChannelCapabilities(receive=frozenset({'text','image','file'}), send=frozenset({'text','image','file'}),
        file_extensions=frozenset({'xlsx','pdf','zip','rar','doc','docx'}))

    def __init__(self, bot: dict, on_message, on_state):
        super().__init__(bot, on_message, on_state)
        self._task: asyncio.Task | None = None
        self._access_token = ""
        self._token_expires_at = 0.0
        self._token_lock = asyncio.Lock()
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

    async def _send_text(self, message: IncomingMessage, text: str) -> None:
        webhook = str(message.reply_context or "")
        if not webhook:
            await self._send_active(message, text)
            return
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

    async def _token(self, session) -> str:
        async with self._token_lock:
            if self._access_token and time.monotonic() < self._token_expires_at:
                return self._access_token
            async with session.post("https://api.dingtalk.com/v1.0/oauth2/accessToken", json={
                "appKey": self._bot["app_id"], "appSecret": self._bot["secret"],
            }) as response:
                response.raise_for_status()
                result = await response.json()
            token = result.get("accessToken")
            if not token:
                raise RuntimeError("钉钉主动发送鉴权失败")
            self._access_token = token
            self._token_expires_at = time.monotonic() + max(0, float(result.get("expireIn", 0)) - 60)
            return token

    async def _send_active(self, message: IncomingMessage, text: str, *, msg_key="sampleText", msg_param=None) -> None:
        payload = {
            "robotCode": self._bot["app_id"], "msgKey": msg_key,
            "msgParam": json.dumps(msg_param if msg_param is not None else {"content": text}, ensure_ascii=False),
        }
        if message.conversation_type == "group":
            endpoint = "groupMessages/send"
            payload["openConversationId"] = message.conversation_id
        else:
            if not message.sender_id:
                raise RuntimeError("钉钉主动私聊缺少用户标识")
            endpoint = "oToMessages/batchSend"
            payload["userIds"] = [message.sender_id]
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            token = await self._token(session)
            async with session.post(f"https://api.dingtalk.com/v1.0/robot/{endpoint}", json=payload,
                                    headers={"x-acs-dingtalk-access-token": token}) as response:
                response.raise_for_status()
                result = await response.json()
            if result.get("errcode") not in (None, 0) or result.get("code") or result.get("invalidUserIdList"):
                raise RuntimeError("钉钉主动消息发送失败")


    async def send(self, recipient: IncomingMessage, message: OutgoingMessage) -> None:
        self.validate_outgoing(message)
        prepared = []
        timeout = aiohttp.ClientTimeout(total=30)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            for attachment in message.attachments:
                token = await self._token(session)
                form = aiohttp.FormData()
                form.add_field('media', attachment.data, filename=attachment.name, content_type=attachment.mime_type)
                async with session.post('https://oapi.dingtalk.com/media/upload',
                    params={'access_token':token,'type':attachment.kind}, data=form) as response:
                    response.raise_for_status()
                    result = await response.json()
                if result.get('errcode') not in (None,0) or not result.get('media_id'):
                    raise RuntimeError('钉钉附件上传失败')
                if attachment.kind == 'image':
                    prepared.append(('sampleImageMsg', {'photoURL':result['media_id']}))
                else:
                    from pathlib import Path
                    prepared.append(('sampleFile', {'mediaId':result['media_id'],'fileName':attachment.name,
                        'fileType':Path(attachment.name).suffix.lower().lstrip('.')}))
        if message.text:
            await self._send_text(recipient, message.text)
        for msg_key, msg_param in prepared:
            await self._send_active(recipient, '', msg_key=msg_key, msg_param=msg_param)

    async def download(self, attachment: ChannelAttachment) -> tuple[bytes, str]:
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            token = await self._token(session)
            async with session.post('https://api.dingtalk.com/v1.0/robot/messageFiles/download',
                json={'downloadCode':attachment.reference['download_code'],
                      'robotCode':attachment.reference.get('robot_code') or self._bot['app_id']},
                headers={'x-acs-dingtalk-access-token':token}) as response:
                response.raise_for_status()
                result = await response.json()
        if not result.get('downloadUrl'):
            raise RuntimeError('钉钉附件下载地址获取失败')
        data = await fetch_media(result['downloadUrl'], self.CAPABILITIES.limit(attachment.kind),
                                 ('dingtalk.com','alicdn.com','aliyuncs.com'))
        return data, attachment.name
