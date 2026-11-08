"""WeChat ClawBot private conversations via native Python iLink HTTP calls."""
import asyncio
import contextlib
import re
import uuid

from services.channels.base import ChannelCapabilities, ChannelAttachment, ChannelQuote, IncomingMessage
from services.channels.social import SocialAdapter, text_chunks
from services.channels.weixin_api import ILinkClient, SessionExpired, BASE_URL
from services.channels.weixin_state import WeixinState
from services.channels import weixin_media


def _content(items):
    text, attachments = [], []
    for item in items:
        if not isinstance(item, dict):
            continue
        kind = item.get('type')
        if kind == 1:
            text.append(str((item.get('text_item') or {}).get('text') or ''))
        elif kind == 3:
            voice = item.get('voice_item') or {}
            text.append(str(voice.get('text') or '[语音消息暂无转写，请发送文字]'))
        elif kind in (2, 4, 5):
            body = item.get({2: 'image_item', 4: 'file_item', 5: 'video_item'}[kind]) or {}
            media = dict(body.get('media') or {})
            if body.get('aeskey') and not media.get('aes_key'):
                import base64
                media['aes_key'] = base64.b64encode(str(body['aeskey']).encode()).decode()
            if media.get('encrypt_query_param') or media.get('full_url'):
                attachments.append(ChannelAttachment('image' if kind == 2 else 'file',
                    name=body.get('file_name') or ('image.jpg' if kind == 2 else 'video.mp4' if kind == 5 else 'attachment.bin'),
                    reference=media))
    return '\n'.join(filter(None, text)), tuple(attachments[:10])


class WeixinAdapter(SocialAdapter):
    CHANNEL_ID = 'weixin'
    DISPLAY_NAME = '微信 ClawBot'
    CAPABILITIES = ChannelCapabilities(receive=frozenset({'text', 'image', 'file'}),
        send=frozenset({'text', 'image', 'file'}), waiting=True, streaming=True)

    def __init__(self, *args):
        super().__init__(*args)
        self._api = ILinkClient(self._bot['secret'], self._bot.get('weixin_base_url') or BASE_URL)
        self._state = WeixinState(self._bot)
        self._typing = {}
        self._sent_text = {}

    async def start(self):
        if self._task is None:
            await self._state.load()
            await super().start()

    async def stop(self):
        for task in self._typing.values():
            task.cancel()
        await asyncio.gather(*self._typing.values(), return_exceptions=True)
        self._typing.clear()
        await super().stop()
        self._sent_text.clear()
        await self._api.close()

    async def _run(self):
        while True:
            try:
                await self._on_state('connecting', '')
                await self._connect()
            except asyncio.CancelledError:
                raise
            except SessionExpired:
                await self._on_state('error', '微信 ClawBot 登录已失效，请编辑机器人并重新扫码')
                return
            except Exception:
                await self._on_state('reconnecting', '微信 ClawBot 连接中断，正在重试')
                await asyncio.sleep(5)

    async def _connect(self):
        connected = False
        while True:
            result = await self._api.request('getupdates', payload={'get_updates_buf': self._state.cursor})
            if not connected:
                await self._on_state('connected', '')
                connected = True
            for frame in result.get('msgs') or []:
                await self._handle_message(frame)
            cursor = result.get('get_updates_buf')
            if isinstance(cursor, str) and cursor != self._state.cursor:
                self._state.cursor = cursor
                await self._state.save()
            # Avoid a hot loop when an upstream endpoint returns empty immediately.
            await asyncio.sleep(.25)

    async def _handle_message(self, frame):
        if not isinstance(frame, dict):
            return
        sender, message_id = str(frame.get('from_user_id') or ''), str(frame.get('message_id') or '')
        if frame.get('message_type') != 1 or not message_id or not sender or sender != self._bot.get('weixin_user_id'):
            return
        items = frame.get('item_list') or []
        text, attachments = _content(items)
        if not text and not attachments:
            return
        token = frame.get('context_token')
        if isinstance(token, str) and token and self._state.tokens.get(sender) != token:
            self._state.tokens[sender] = token
            await self._state.save()
        quote = None
        for item in items:
            if not isinstance(item, dict):
                continue
            ref = item.get('ref_msg') or {}
            if ref:
                quoted_text, quoted_media = _content([ref['message_item']] if isinstance(ref.get('message_item'), dict) else [])
                quote = ChannelQuote(quoted_text or str(ref.get('title') or ''), quoted_media)
                break
        self._dispatch(IncomingMessage(self._bot['id'], message_id, 'single', sender, sender, text,
            reply_context={'context_token': token} if token else None, attachments=attachments, quote=quote))

    def _context(self, recipient):
        if recipient.conversation_type != 'single':
            raise ValueError('微信 ClawBot 仅支持私聊')
        if recipient.conversation_id != self._bot.get('weixin_user_id'):
            raise ValueError('微信 ClawBot 只能发送给扫码绑定的用户')
        return ((recipient.reply_context or {}).get('context_token') if isinstance(recipient.reply_context, dict) else None) or self._state.tokens.get(recipient.conversation_id)

    async def send(self, recipient, message):
        self.validate_outgoing(message)
        self._context(recipient)
        sent = self._sent_text.get(recipient.message_id, '')
        text = message.text[len(sent):] if message.text.startswith(sent) else message.text
        self.release_reply(recipient)
        items = [[{'type': 1, 'text_item': {'text': chunk}}] for chunk in text_chunks(text, 3500)]
        for attachment in message.attachments:
            items.append([await weixin_media.upload(self._api, recipient.conversation_id, attachment)])
        for item_list in items:
            await self._send_items(recipient, item_list)

    async def _send_items(self, recipient, items):
        token = self._context(recipient)
        body = {'from_user_id': '', 'to_user_id': recipient.conversation_id, 'client_id': 'workstep-' + uuid.uuid4().hex,
                'message_type': 2, 'message_state': 2, 'item_list': items}
        if token:
            body['context_token'] = token
        await self._api.request('sendmessage', payload={'msg': body})

    async def update_reply(self, recipient, text):
        # Media Markdown is resolved by outgoing_content at completion. Hold the
        # suffix from the first potential link so paths/incomplete images don't leak.
        link = re.search(r'!?\[|!$', text)
        if link:
            text = text[:link.start()]
        sent = self._sent_text.get(recipient.message_id, '')
        if not text.startswith(sent) or text == sent:
            return
        remaining = text[len(sent):]
        while len(remaining) >= 200:
            candidate = next(text_chunks(remaining, 3500))
            boundaries = [match.end() for match in re.finditer(r'[。！？\n]|[.!?](?=\s|$)', candidate)
                          if match.end() >= 200]
            if boundaries:
                chunk = candidate[:boundaries[-1]]
            elif len(candidate) < len(remaining):
                chunk = candidate  # Bound exceptionally long, unpunctuated text.
            else:
                return  # Await a newer cumulative snapshot or final delivery.
            async def deliver(block=chunk):
                await asyncio.wait_for(self._send_items(recipient, [{'type': 1, 'text_item': {'text': block}}]), 15)
                self._sent_text[recipient.message_id] = self._sent_text.get(recipient.message_id, '') + block
            delivery = asyncio.create_task(deliver())
            try:
                await asyncio.shield(delivery)
            except asyncio.CancelledError:
                # Stream.close cancels progress before final delivery. Finish the
                # bounded in-flight send and record its ACK before computing tail.
                await delivery
                raise
            remaining = remaining[len(chunk):]

    async def download(self, attachment):
        return await weixin_media.download(self._api, attachment, self.CAPABILITIES.limit(attachment.kind))

    async def start_reply(self, message):
        self.release_reply(message)
        token = self._context(message)
        async def typing():
            ticket = None
            try:
                config = await self._api.request('getconfig', payload={'ilink_user_id': message.sender_id,
                    **({'context_token': token} if token else {})})
                ticket = config.get('typing_ticket')
                if ticket:
                    for _ in range(24):
                        await self._api.request('sendtyping', payload={'ilink_user_id': message.sender_id, 'typing_ticket': ticket, 'status': 1})
                        await asyncio.sleep(10)
            except (RuntimeError, ValueError):
                pass
            finally:
                if ticket:
                    with contextlib.suppress(Exception):
                        await asyncio.wait_for(self._api.request('sendtyping', payload={
                            'ilink_user_id': message.sender_id, 'typing_ticket': ticket, 'status': 2}), 2)
        task = asyncio.create_task(typing())
        self._typing[message.message_id] = task
        task.add_done_callback(lambda finished: self._typing.pop(message.message_id, None)
                               if self._typing.get(message.message_id) is finished else None)

    def release_reply(self, message):
        self._sent_text.pop(message.message_id, None)
        task = self._typing.get(message.message_id)
        if task:
            task.cancel()
