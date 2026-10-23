"""Feishu/Lark bots: official WS framing, asynchronous HTTP and shared controls."""
from __future__ import annotations

import asyncio
from dataclasses import replace
import json
import logging
import time
from urllib.parse import parse_qs, quote, urlsplit

import httpx
import websockets
from services.channels.card_status import CardStatus

from services.channels.base import (
    ChannelAction, ChannelAdapter, ChannelAttachment, ChannelCapabilities,
    ChannelCard, ChannelQuote, IncomingMessage, OutgoingMessage,
)

logger = logging.getLogger(__name__)


def _chunks(text, budget=12000):
    """Bound JSON-encoded UTF-8 text, including escaped control characters."""
    start = size = 0
    for index, char in enumerate(text):
        length = 2 if char in '\\"\b\f\n\r\t' else 6 if ord(char) < 32 else len(char.encode())
        if size + length > budget:
            yield text[start:index]
            start, size = index, 0
        size += length
    if text[start:]:
        yield text[start:]


class _Dispatcher:
    def __init__(self, adapter):
        self.adapter = adapter

    def _do_without_validation(self, payload):
        # The authenticated outbound socket is the trust boundary. ACK before
        # scheduling an assistant or acquiring any project/database lock.
        data = json.loads(payload)
        if data.get('header', {}).get('app_id') != self.adapter._bot['app_id']:
            raise ValueError('Feishu event application mismatch')
        kind = data.get('header', {}).get('event_type')
        if kind == 'card.action.trigger':
            self.adapter._spawn(self.adapter._handle_action(data))
            return {'toast': {'type': 'info', 'content': '正在处理…'}}
        if kind == 'im.message.receive_v1':
            self.adapter._spawn(self.adapter._handle_event(data))


class FeishuAdapter(ChannelAdapter):
    CHANNEL_ID = 'feishu'
    DISPLAY_NAME = '飞书'
    DOMAIN = 'https://open.feishu.cn'
    CAPABILITIES = ChannelCapabilities(
        receive=frozenset({'text', 'image', 'file'}), send=frozenset({'text', 'image', 'file'}),
        waiting=True, streaming=True, cards=True,
    )

    def __init__(self, bot, on_message, on_state):
        super().__init__(bot, on_message, on_state)
        self._http = None
        self._task = None
        self._tasks = set()
        self._token = ''
        self._expires = 0
        self._token_lock = asyncio.Lock()
        self._bot_open_id = ''
        self._names = {}
        self._reply_cards = {}
        self._cards = {}
        self._card_message_ids = {}
        self._card_locks = {}
        self._reply_status = {}
        self._card_status = {}
        self._outcomes = {}

    def _spawn(self, coroutine):
        task = asyncio.create_task(coroutine)
        self._tasks.add(task)
        def done(completed):
            self._tasks.discard(completed)
            if not completed.cancelled() and completed.exception():
                logger.error('%s event processing failed', self.DISPLAY_NAME, exc_info=completed.exception())
        task.add_done_callback(done)
        return task

    def _client(self):
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=20, follow_redirects=False)
        return self._http

    @staticmethod
    def _checked(response):
        response.raise_for_status()
        try:
            data = response.json()
        except ValueError as exc:
            raise RuntimeError('飞书接口返回了无效数据') from exc
        if not isinstance(data, dict) or data.get('code', 0) != 0:
            # Do not expose request bodies, access tokens or credential URLs.
            raise RuntimeError(f'飞书接口失败（错误码 {data.get("code", "unknown") if isinstance(data, dict) else "unknown"}）')
        return data

    async def _access_token(self):
        async with self._token_lock:
            if self._token and time.monotonic() < self._expires:
                return self._token
            data = self._checked(await self._client().post(self.DOMAIN + '/open-apis/auth/v3/tenant_access_token/internal',
                json={'app_id': self._bot['app_id'], 'app_secret': self._bot['secret']}))
            if not data.get('tenant_access_token'):
                raise RuntimeError('飞书应用凭证缺失')
            self._token = data['tenant_access_token']
            self._expires = time.monotonic() + max(0, float(data.get('expire', 0)) - 60)
            return self._token

    async def _api(self, method, path, **kwargs):
        token = await self._access_token()
        response = await self._client().request(method, self.DOMAIN + '/open-apis' + path,
            headers={'Authorization': 'Bearer ' + token}, **kwargs)
        try:
            data = self._checked(response)
        except RuntimeError:
            try:
                payload = response.json()
                if isinstance(payload, dict) and payload.get('code') in {99991661, 99991663, 99991664, 99991668, 99991671}:
                    self._expires = 0
            except ValueError:
                pass
            raise
        return data.get('data', data)

    async def start(self):
        if self._task is None:
            self._task = asyncio.create_task(self._run())

    async def stop(self):
        tasks = tuple(self._tasks) + ((self._task,) if self._task else ())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._task = None
        self._tasks.clear()
        if self._http:
            await self._http.aclose()
            self._http = None
        self._reply_cards.clear()
        self._cards.clear()
        self._card_message_ids.clear()
        self._card_locks.clear()
        self._names.clear()
        self._reply_status.clear()
        self._card_status.clear()
        self._outcomes.clear()
        self._token, self._expires = '', 0

    async def _ping(self, protocol, socket):
        from lark_oapi.ws.client import _new_ping_frame
        try:
            while True:
                await protocol._write_message(_new_ping_frame(int(protocol._service_id)).SerializeToString())
                await asyncio.sleep(max(1, protocol._ping_interval))
        except Exception:
            await socket.close()

    async def _run(self):
        # Importing the full SDK is blocking module/file work. Its public
        # start() uses a global loop and synchronous requests; neither is used.
        def load_sdk():
            from lark_oapi.ws.client import Client
            from lark_oapi.core.enum import LogLevel
            return Client, LogLevel
        Client, LogLevel = await asyncio.to_thread(load_sdk)
        protocol = Client(self._bot['app_id'], self._bot['secret'], domain=self.DOMAIN,
                          event_handler=_Dispatcher(self), log_level=LogLevel.WARNING, auto_reconnect=False)
        try:
            while True:
                ping = None
                try:
                    info = await self._api('GET', '/bot/v3/info')
                    self._bot_open_id = (info.get('bot') or {}).get('open_id') or ''
                    if not self._bot_open_id:
                        raise RuntimeError('飞书机器人身份缺失，请启用应用机器人能力')
                    endpoint = self._checked(await self._client().post(self.DOMAIN + '/callback/ws/endpoint',
                        json={'AppID': self._bot['app_id'], 'AppSecret': self._bot['secret']}))['data']
                    uri = endpoint['URL']
                    if urlsplit(uri).scheme != 'wss':
                        raise RuntimeError('飞书长连接地址无效')
                    from lark_oapi.ws.model import ClientConfig
                    if endpoint.get('ClientConfig'):
                        protocol._configure(ClientConfig(endpoint['ClientConfig']))
                    async with websockets.connect(uri, max_size=8 * 1024 * 1024, open_timeout=15) as socket:
                        protocol._conn = socket
                        protocol._service_id = parse_qs(urlsplit(uri).query)['service_id'][0]
                        ping = asyncio.create_task(self._ping(protocol, socket))
                        await self._on_state('connected', '')
                        async for raw in socket:
                            await protocol._handle_message(raw)
                        raise RuntimeError('长连接已断开，正在重试')
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    reason = str(exc) if isinstance(exc, RuntimeError) else '连接失败，请检查应用凭证、网络及事件订阅'
                    await self._on_state('reconnecting', self.DISPLAY_NAME + '：' + reason)
                finally:
                    if ping:
                        ping.cancel()
                        await asyncio.gather(ping, return_exceptions=True)
                    protocol._conn = None
                await asyncio.sleep(3)
        finally:
            # The SDK fragmentation cache owns an expiry task on this loop.
            protocol._cache._cron.cancel()
            await asyncio.gather(protocol._cache._cron, return_exceptions=True)

    async def _name(self, kind, identifier):
        key = kind, identifier
        cached = self._names.get(key)
        if cached and cached[1] > time.monotonic():
            return cached[0]
        name = ''
        try:
            path = '/im/v1/chats/' if kind == 'chat' else '/contact/v3/users/'
            data = await self._api('GET', path + quote(identifier, safe=''), **({} if kind == 'chat' else {'params': {'user_id_type': 'open_id'}}))
            name = (data if kind == 'chat' else data.get('user', {})).get('name') or ''
        except (httpx.HTTPError, RuntimeError):
            pass
        if len(self._names) >= 1000:
            self._names.pop(next(iter(self._names)))
        self._names[key] = name, time.monotonic() + 300
        return name

    def _content(self, message):
        body = json.loads(message.get('content') or '{}')
        kind = message.get('message_type')
        text, attachments = '', []
        def media(media_kind, key, name=''):
            if key:
                attachments.append(ChannelAttachment(media_kind, name=name,
                    reference={'message_id': message['message_id'], 'file_key': key}))
        if kind == 'text':
            text = body.get('text') or ''
            for mention in message.get('mentions') or []:
                token = mention.get('key') or ''
                if token:
                    identifier = mention.get('id') or {}
                    is_bot = (identifier.get('open_id') if isinstance(identifier, dict) else identifier) == self._bot_open_id
                    text = text.replace(token, '' if is_bot else '@' + (mention.get('name') or token))
        elif kind == 'image':
            media('image', body.get('image_key'), 'image.png')
        elif kind == 'file':
            media('file', body.get('file_key'), body.get('file_name') or 'file')
        elif kind == 'post':
            post = body if 'content' in body else body.get('zh_cn') or body.get('en_us') or next(iter(body.values()), {})
            lines = [post.get('title') or '']
            for row in post.get('content') or []:
                line = ''
                for item in row:
                    tag = item.get('tag')
                    if tag == 'text': line += item.get('text') or ''
                    elif tag == 'a': line += '[' + (item.get('text') or item.get('href') or '') + '](' + (item.get('href') or '') + ')'
                    elif tag == 'at' and item.get('user_id') != self._bot_open_id:
                        line += '@' + (item.get('user_name') or item.get('user_id') or '')
                    elif tag == 'img': media('image', item.get('image_key'), 'image.png')
                lines.append(line)
            text = '\n'.join(lines)
        return text.strip(), tuple(attachments)

    async def _handle_event(self, payload):
        event = payload.get('event') or {}
        sender, message = event.get('sender') or {}, event.get('message') or {}
        sender_id = (sender.get('sender_id') or {}).get('open_id')
        if sender.get('sender_type') != 'user' or not sender_id or not message.get('chat_id') or not message.get('message_id'):
            return
        group = message.get('chat_type') == 'group'
        if group and not any((mention.get('id') or {}).get('open_id') == self._bot_open_id
                             for mention in message.get('mentions') or []):
            return
        try:
            text, attachments = self._content(message)
        except (ValueError, TypeError, KeyError):
            logger.warning('Unsupported or malformed %s message', self.DISPLAY_NAME)
            return
        quoted = None
        if message.get('parent_id'):
            try:
                data = await self._api('GET', '/im/v1/messages/' + quote(message['parent_id'], safe=''))
                parent = next((item for item in data.get('items', []) if item.get('message_id') == message['parent_id']
                               and item.get('chat_id') == message['chat_id'] and not item.get('deleted')), None)
                if parent:
                    quote_text, quote_attachments = self._content({**parent, 'message_type': parent.get('msg_type'),
                        'content': (parent.get('body') or {}).get('content')})
                    if quote_text or quote_attachments:
                        quoted = ChannelQuote(quote_text, quote_attachments)
            except (httpx.HTTPError, RuntimeError, ValueError, TypeError, KeyError):
                logger.warning('%s quoted message is unavailable', self.DISPLAY_NAME)
        if not text and not attachments and quoted is None:
            return
        sender_name, group_name = await asyncio.gather(self._name('user', sender_id), self._name('chat', message['chat_id']) if group else asyncio.sleep(0, result=''))
        await self._on_message(IncomingMessage(self._bot['id'], message['message_id'], 'group' if group else 'single',
            message['chat_id'], sender_id, text, sender_name=sender_name, conversation_name=group_name,
            attachments=attachments, quote=quoted))

    @staticmethod
    def _reply_key(recipient):
        return recipient.conversation_type, recipient.conversation_id, recipient.message_id

    def set_reply_metadata(self, recipient, metadata):
        self._reply_status.setdefault(self._reply_key(recipient), CardStatus()).metadata.update(metadata)

    def observe_reply(self, recipient, event):
        key = self._reply_key(recipient)
        self._reply_status.setdefault(key, CardStatus()).observe(event)
        if event.get('type') == 'TEXT_MESSAGE_END':
            self._outcomes[key] = event.get('status')

    async def _send_message(self, recipient, kind, content):
        group = recipient.conversation_type == 'group'
        return await self._api('POST', '/im/v1/messages', params={'receive_id_type': 'chat_id' if group else 'open_id'}, json={
            'receive_id': recipient.conversation_id if group else recipient.sender_id,
            'msg_type': kind, 'content': json.dumps(content, ensure_ascii=False),
        })

    def _card_json(self, card):
        elements = [{'tag': 'markdown', 'content': card.text or '正在处理…'}]
        if card.id in self._card_status:
            elements.append({'tag': 'note', 'elements': [{'tag': 'plain_text', 'content': self._card_status[card.id].render()}]})
        if card.message_id:
            elements.append({'tag': 'note', 'elements': [{'tag': 'plain_text', 'content': '消息 ID: ' + card.message_id}]})
        if card.input_prompt:
            elements.append({'tag': 'note', 'elements': [{'tag': 'plain_text', 'content': '点击「填写意见」后发送下一条文字；群聊需再次 @机器人。'}]})
        for offset in range(0, len(card.buttons), 3):
            elements.append({'tag': 'action', 'actions': [{'tag': 'button', 'text': {'tag': 'plain_text', 'content': button.label},
                'type': 'danger' if button.danger else 'default', 'value': {'card_id': card.id, 'key': button.key}} for button in card.buttons[offset:offset + 3]]})
        return {'config': {'wide_screen_mode': True, 'update_multi': True},
                'header': {'title': {'tag': 'plain_text', 'content': card.title[:100] or self.DISPLAY_NAME}}, 'elements': elements}

    async def send_card(self, recipient, card):
        async with self._card_locks.setdefault(card.id, asyncio.Lock()):
            if card.running:
                self._card_status[card.id] = self._reply_status.setdefault(self._reply_key(recipient), CardStatus())
            previous = self._reply_cards.get(self._reply_key(recipient)) if card.running else None
            if previous and previous != card.id:
                message_id = self._card_message_ids[previous]
                await self._api('PATCH', '/im/v1/messages/' + quote(message_id, safe=''),
                                json={'content': json.dumps(self._card_json(card), ensure_ascii=False)})
                data = {'message_id': message_id}
                self._cards.pop(previous, None)
                self._card_message_ids.pop(previous, None)
                self._card_locks.pop(previous, None)
                self._card_status.pop(previous, None)
            else:
                data = await self._send_message(recipient, 'interactive', self._card_json(card))
            if not data.get('message_id'):
                raise RuntimeError('飞书卡片消息标识缺失')
            self._cards[card.id] = card
            self._card_message_ids[card.id] = data['message_id']
            if card.running:
                self._reply_cards[self._reply_key(recipient)] = card.id

    async def update_card(self, recipient, card):
        if card.id not in self._card_message_ids:
            return
        async with self._card_locks.setdefault(card.id, asyncio.Lock()):
            message_id = self._card_message_ids.get(card.id)
            if message_id:
                # Expiring a stop control must preserve the latest reply body.
                current = self._cards.get(card.id)
                if current and card.running and not card.buttons and card.title == '已结束':
                    card = replace(card, text=current.text, running=False)
                await self._api('PATCH', '/im/v1/messages/' + quote(message_id, safe=''),
                                json={'content': json.dumps(self._card_json(card), ensure_ascii=False)})
                self._cards[card.id] = card

    async def start_reply(self, recipient):
        if self._reply_key(recipient) not in self._reply_cards:
            card = ChannelCard('reply-' + recipient.message_id, '正在处理', '正在处理…', running=True)
            await self.send_card(recipient, card)

    async def update_reply(self, recipient, text):
        await self.start_reply(recipient)
        card_id = self._reply_cards[self._reply_key(recipient)]
        current = self._cards[card_id]
        preview = next(_chunks(text), '正在处理…')
        await self.update_card(recipient, replace(current, text=preview))

    def release_reply(self, recipient):
        key = self._reply_key(recipient)
        card_id = self._reply_cards.pop(key, None)
        self._reply_status.pop(key, None)
        self._outcomes.pop(key, None)
        if card_id:
            self._cards.pop(card_id, None)
            self._card_message_ids.pop(card_id, None)
            self._card_locks.pop(card_id, None)
            self._card_status.pop(card_id, None)

    async def send(self, recipient, message):
        self.validate_outgoing(message)
        uploaded = []
        for attachment in message.attachments:
            image = attachment.kind == 'image'
            result = await self._api('POST', '/im/v1/images' if image else '/im/v1/files',
                data={'image_type': 'message'} if image else {'file_type': 'stream', 'file_name': attachment.name},
                files={'image' if image else 'file': (attachment.name, attachment.data, attachment.mime_type)})
            key = 'image_key' if image else 'file_key'
            if not result.get(key):
                raise RuntimeError('飞书媒体上传标识缺失')
            uploaded.append((attachment.kind, {key: result[key]}))
        pieces = list(_chunks(message.text))
        card_id = self._reply_cards.get(self._reply_key(recipient))
        if card_id:
            try:
                current = self._cards[card_id]
                status = self._reply_status.get(self._reply_key(recipient))
                if status and status.finished is None:
                    status.finished = time.monotonic()
                outcome = self._outcomes.get(self._reply_key(recipient))
                label = '已停止' if outcome in {'stopped', 'cancelled'} else '执行失败' if outcome == 'failed' else '已完成'
                title = (current.title if current.title.startswith('@') else self.DISPLAY_NAME) + ' · ' + label
                await self.update_card(recipient, replace(current, title=title, text=pieces[0] if pieces else '已完成', buttons=(), running=False))
                pieces = pieces[1:]
            except (httpx.HTTPError, RuntimeError):
                logger.warning('%s reply card failed; sending complete text', self.DISPLAY_NAME)
            finally:
                self.release_reply(recipient)
        for text in pieces:
            await self._send_message(recipient, 'text', {'text': text})
        for kind, body in uploaded:
            await self._send_message(recipient, kind, body)

    async def download(self, attachment):
        reference = attachment.reference
        path = '/im/v1/messages/' + quote(reference['message_id'], safe='') + '/resources/' + quote(reference['file_key'], safe='')
        token = await self._access_token()
        async with self._client().stream('GET', self.DOMAIN + '/open-apis' + path,
            headers={'Authorization': 'Bearer ' + token}, params={'type': attachment.kind}) as response:
            response.raise_for_status()
            limit = self.CAPABILITIES.limit(attachment.kind)
            if int(response.headers.get('content-length', 0)) > limit:
                raise ValueError('附件超过渠道大小限制')
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > limit:
                    raise ValueError('附件超过渠道大小限制')
            if not data or 'application/json' in response.headers.get('content-type', ''):
                raise ValueError('飞书附件下载失败')
            filename = attachment.name or 'attachment.bin'
            if attachment.kind == 'image':
                suffix = {'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp'}.get(
                    response.headers.get('content-type', '').split(';', 1)[0])
                filename = 'image' + suffix if suffix else attachment.name or 'image.png'
            return bytes(data), filename

    async def _handle_action(self, payload):
        event = payload.get('event') or {}
        operator, context, action = event.get('operator') or {}, event.get('context') or {}, event.get('action') or {}
        value = action.get('value') or {}
        if not isinstance(value, dict) or not self._on_action:
            return
        card_id, key = value.get('card_id'), value.get('key')
        user_id, chat_id, message_id = operator.get('open_id'), context.get('open_chat_id'), context.get('open_message_id')
        if not all(isinstance(item, str) and item for item in (card_id, key, user_id, chat_id, message_id)):
            return
        if card_id in self._card_message_ids and self._card_message_ids[card_id] != message_id:
            return
        self._card_message_ids[card_id] = message_id
        form = action.get('form_value') or {}
        comment = form.get('comment') if isinstance(form, dict) else None
        click = ChannelAction(self._bot['id'], card_id, key, user_id, conversation_id=chat_id, comment=comment)
        claimed = False
        async def on_claimed():
            nonlocal claimed
            claimed = True
        result = await self._on_action(click, on_claimed=on_claimed)
        recipient = IncomingMessage(self._bot['id'], '', 'group', chat_id, user_id, '')
        current = self._cards.get(card_id)
        if claimed and current:
            await self.update_card(recipient, replace(current, buttons=(), running=False))
        if result:
            await self._send_message(recipient, 'text', {'text': str(result)})


class LarkAdapter(FeishuAdapter):
    CHANNEL_ID = 'lark'
    DISPLAY_NAME = 'Lark'
    DOMAIN = 'https://open.larksuite.com'
