"""DingTalk Stream bot using official message types and an async connection loop."""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import replace
from urllib.parse import quote_plus

import aiohttp
import websockets
from dingtalk_stream import AckMessage, ChatbotHandler, ChatbotMessage, Credential, DingTalkStreamClient, CallbackHandler

from services.channels.base import ChannelAdapter, ChannelCapabilities, ChannelAttachment, IncomingMessage, OutgoingMessage, ChannelCard, ChannelAction
from services.channels.media import fetch_media


logger = logging.getLogger(__name__)
CARD_TOPIC = '/v1.0/card/instances/callback'
# Public Markdown-button template shipped by the official DingTalk Python SDK.
DEFAULT_CARD_TEMPLATE_ID = '1366a1eb-bc54-4859-ac88-517c56a9acb1.schema'


class _CardHandler(CallbackHandler):
    def __init__(self, adapter):
        super().__init__()
        self._adapter = adapter

    async def process(self, callback):
        raw = callback.data
        content = raw.get('content') or {}
        if isinstance(content, str):
            try:
                content = json.loads(content)
            except ValueError:
                return AckMessage.STATUS_OK, 'Invalid card payload'
        private = content.get('cardPrivateData') or {}
        ids = private.get('actionIds') or []
        if ids:
            click = ChannelAction(self._adapter._bot['id'], str(raw.get('outTrackId') or ''),
                str(ids[0]), str(raw.get('userId') or ''), conversation_id=str(raw.get('spaceId') or ''))
            task = asyncio.create_task(self._adapter._card_action(click))
            self._adapter._action_tasks.add(task)
            task.add_done_callback(self._adapter._action_tasks.discard)
        # ACK immediately; never block the Stream reader on an LLM or workflow.
        return AckMessage.STATUS_OK, 'OK'



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
        file_extensions=frozenset({'xlsx','pdf','zip','rar','doc','docx'}), cards=True, streaming=True)

    def __init__(self, bot: dict, on_message, on_state):
        super().__init__(bot, on_message, on_state)
        self._task: asyncio.Task | None = None
        self._access_token = ""
        self._token_expires_at = 0.0
        self._token_lock = asyncio.Lock()
        self._action_tasks = set()
        self._reply_cards = {}
        self._card_message_ids = {}
        self._running_reply_cards = {}
        self._client = DingTalkStreamClient(Credential(bot["app_id"], bot["secret"]))
        self._client.register_callback_handler(
            ChatbotMessage.TOPIC, _MessageHandler(bot["id"], on_message),
        )
        self._client.register_callback_handler(CARD_TOPIC, _CardHandler(self))

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._reply_cards.clear()
        self._card_message_ids.clear()
        self._running_reply_cards.clear()
        for task in tuple(self._action_tasks):
            task.cancel()
        if self._action_tasks:
            await asyncio.gather(*self._action_tasks, return_exceptions=True)
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
                        "subscriptions": [{"type": "CALLBACK", "topic": topic} for topic in (ChatbotMessage.TOPIC, CARD_TOPIC)],
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
        payload = {"msgtype": "text", "text": {"content": text}}
        if message.conversation_type == 'group' and message.sender_id:
            payload['at'] = {'atUserIds': [message.sender_id], 'isAtAll': False}
            payload['text']['content'] = '@' + message.sender_id + '\n' + text
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(webhook, json=payload) as response:
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


    def _card_data(self, card: ChannelCard) -> dict:
        message_id = card.message_id or self._card_message_ids.get(card.id, '')
        return {"title":card.title, "markdown":card.text, "tips":'消息 ID: ' + message_id if message_id else '',
                "sys_full_json_obj":json.dumps({"msgButtons":[{"text":b.label,"id":b.key,"request":True,"color":"blue"} for b in card.buttons]}, ensure_ascii=False)}

    async def _card_api(self, method, payload):
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            token = await self._token(session)
            url = 'https://api.dingtalk.com/v1.0/card/instances' + ('/createAndDeliver' if method == 'POST' else '')
            async with session.request(method, url, json=payload, headers={'x-acs-dingtalk-access-token':token}) as response:
                response.raise_for_status()
                result = await response.json()
            if result.get('code') or result.get('errcode') not in (None, 0):
                raise RuntimeError('钉钉卡片操作失败，请检查卡片发送权限和模板配置')
            return result

    async def send_card(self, recipient: IncomingMessage, card: ChannelCard) -> None:
        group = recipient.conversation_type == 'group'
        space = 'IM_GROUP' if group else 'IM_ROBOT'
        target = recipient.conversation_id if group else recipient.sender_id
        payload = {
            'cardTemplateId':self._bot.get('card_template_id') or DEFAULT_CARD_TEMPLATE_ID,
            'outTrackId':card.id, 'callbackType':'STREAM', 'userIdType':1,
            'cardData':{'cardParamMap':self._card_data(card)},
            'openSpaceId':f'dtv1.card//{space}.{target}',
            ('imGroupOpenSpaceModel' if group else 'imRobotOpenSpaceModel'):{'supportForward':False},
            ('imGroupOpenDeliverModel' if group else 'imRobotOpenDeliverModel'):{'robotCode':self._bot['app_id'], **({} if group else {'spaceType':'IM_ROBOT'})},
        }
        await self._card_api('POST',payload)
        if card.message_id:
            self._card_message_ids[card.id] = card.message_id
        if card.running:
            self._reply_cards[self._reply_key(recipient)] = card.id
            self._running_reply_cards[card.id] = card

    async def update_card(self, recipient: IncomingMessage, card: ChannelCard) -> None:
        previous = self._running_reply_cards.get(card.id)
        closing = card.running and not card.buttons
        if closing and previous is not None:
            # Expiring the stop action must preserve the latest reply body.
            card = replace(previous, buttons=(), running=False, message_id=card.message_id or previous.message_id)
        await self._card_api('PUT', {'outTrackId':card.id,'cardData':{'cardParamMap':self._card_data(card)}})
        if previous is not None:
            if closing:
                self._running_reply_cards.pop(card.id, None)
            else:
                self._running_reply_cards[card.id] = card

    def _reply_key(self, recipient: IncomingMessage) -> str:
        return uuid.uuid5(uuid.NAMESPACE_URL, f'workstep:dingtalk:reply:{recipient.bot_id}:{recipient.conversation_id}:{recipient.message_id}').hex

    def release_reply(self, message: IncomingMessage) -> None:
        card_id = self._reply_cards.pop(self._reply_key(message), None)
        self._card_message_ids.pop(card_id, None)

    async def update_reply(self, message: IncomingMessage, text: str) -> None:
        key = self._reply_key(message)
        card_id = self._reply_cards.get(key) or uuid.uuid4().hex
        running = self._running_reply_cards.get(card_id)
        card = ChannelCard(card_id, 'WorkStep', text, running.buttons if running else (), running=bool(running and running.buttons))
        if key in self._reply_cards:
            await self.update_card(message, card)
        else:
            await self.send_card(message, card)
            self._reply_cards[key] = card_id

    async def _card_action(self, click):
        if self._on_action is None:
            return
        claimed = False
        async def acknowledge():
            nonlocal claimed
            claimed = True
            try:
                await self.update_card(None, ChannelCard(click.card_id,'正在处理你的选择','请稍候'))
            except Exception:
                logger.warning('Failed to update DingTalk card', exc_info=True)
        try:
            result = await self._on_action(click, on_claimed=acknowledge)
            if claimed:
                await self.update_card(None, ChannelCard(click.card_id, result, result))
            elif click.sender_id:
                await self._send_active(IncomingMessage(click.bot_id,'','single',click.sender_id,click.sender_id,''), result)
        except Exception:
            logger.exception('DingTalk card callback failed')

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
        notify_completion = bool(prepared and not message.text and recipient.conversation_type == 'group'
                                 and recipient.sender_id and recipient.reply_context)
        if message.text:
            card_id = self._reply_cards.get(self._reply_key(recipient))
            if card_id:
                try:
                    await self.update_card(recipient, ChannelCard(card_id, 'WorkStep', message.text))
                except Exception:
                    logger.warning('DingTalk progress card update failed; sending full result', exc_info=True)
                    await self._send_text(recipient, message.text)
                else:
                    if recipient.conversation_type == 'group' and recipient.sender_id and recipient.reply_context:
                        notify_completion = True
                finally:
                    self.release_reply(recipient)
            else:
                await self._send_text(recipient, message.text)
        for msg_key, msg_param in prepared:
            await self._send_active(recipient, '', msg_key=msg_key, msg_param=msg_param)
        if notify_completion:
            try:
                await self._send_text(recipient, '回复已完成，请查看上方消息。')
            except Exception:
                logger.warning('DingTalk completion mention failed after result delivery', exc_info=True)

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
