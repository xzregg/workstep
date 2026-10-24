"""Official QQ bot API v2, C2C and group @ messages over Gateway."""
import asyncio
import json
import random
import re
import time
from urllib.parse import quote

import httpx
import websockets

from services.channels.base import IncomingMessage
from services.channels.social import SocialAdapter, text_chunks


class QQAdapter(SocialAdapter):
    CHANNEL_ID = 'qq'
    DISPLAY_NAME = 'QQ'
    API_ROOT = 'https://api.bot.qq.com'

    def __init__(self, *args):
        super().__init__(*args)
        self._token, self._expires = '', 0
        self._token_lock = asyncio.Lock()
        self._session_id, self._sequence = '', None
        self._user_id = ''

    @staticmethod
    def _checked(data):
        if not isinstance(data, dict) or data.get('code', 0) not in (0, None):
            code = data.get('code') if isinstance(data, dict) else None
            # Platform error messages may echo credentials or request bodies.
            code = code if isinstance(code, int) else 'unknown'
            raise RuntimeError(f'QQ 接口失败（错误码 {code}），请检查凭证、权限及发送限制')
        return data

    async def _access_token(self):
        async with self._token_lock:
            if self._token and time.monotonic() < self._expires:
                return self._token
            data = self._checked(await self._request('POST', self.API_ROOT + '/app/getAppAccessToken',
                json={'appId': self._bot['app_id'], 'clientSecret': self._bot['secret']}))
            token = data.get('access_token')
            try:
                lifetime = float(data.get('expires_in', 0))
            except (TypeError, ValueError):
                lifetime = 0
            if not isinstance(token, str) or not token or lifetime <= 0:
                raise RuntimeError('QQ 访问凭证无效，请检查 App ID 和 App Secret')
            self._token, self._expires = token, time.monotonic() + max(1, lifetime - 60)
            return token

    async def _api(self, method, path, **kwargs):
        client = await self._client()
        for attempt in range(2):
            token = await self._access_token()
            try:
                response = await client.request(method, self.API_ROOT + path,
                    headers={'Authorization': 'QQBot ' + token, 'X-Union-Appid': self._bot['app_id']}, **kwargs)
                if response.status_code == 401 and attempt == 0:
                    async with self._token_lock:
                        if self._token == token:
                            self._expires = 0
                    continue
                # Read business errors even when the HTTP status is successful.
                data = self._checked(response.json())
                response.raise_for_status()
                return data
            except (httpx.HTTPError, ValueError):
                raise RuntimeError('QQ 接口请求失败，请检查凭证、权限及网络') from None

    async def _connect(self):
        gateway = await self._api('GET', '/gateway')
        token = 'QQBot ' + await self._access_token()
        async with websockets.connect(gateway['url'], open_timeout=15, max_size=2 * 1024 * 1024) as socket:
            hello = json.loads(await asyncio.wait_for(socket.recv(), 15))
            if hello.get('op') != 10:
                raise RuntimeError('QQ Gateway 握手失败')
            interval = float(hello['d']['heartbeat_interval']) / 1000
            if interval <= 0:
                raise RuntimeError('QQ Gateway 心跳间隔无效')
            acknowledged = True
            async def heartbeat():
                nonlocal acknowledged
                await asyncio.sleep(random.random() * interval)
                while True:
                    if not acknowledged:
                        await socket.close()
                        return
                    acknowledged = False
                    await socket.send(json.dumps({'op': 1, 'd': self._sequence}))
                    await asyncio.sleep(interval)
            pulse = asyncio.create_task(heartbeat())
            try:
                if self._session_id:
                    await socket.send(json.dumps({'op': 6, 'd': {'token': token,
                        'session_id': self._session_id, 'seq': self._sequence}}))
                else:
                    await socket.send(json.dumps({'op': 2, 'd': {'token': token,
                        'intents': 1 << 25, 'shard': [0, 1]}}))
                async for raw in socket:
                    frame = json.loads(raw)
                    if frame.get('s') is not None:
                        self._sequence = frame['s']
                    operation = frame.get('op')
                    if operation == 11:
                        acknowledged = True
                    elif operation == 1:
                        await socket.send(json.dumps({'op': 1, 'd': self._sequence}))
                    elif operation == 7:
                        return
                    elif operation == 9:
                        if not frame.get('d'):
                            self._session_id, self._sequence = '', None
                        return
                    elif operation == 0:
                        event, body = frame.get('t'), frame.get('d') or {}
                        if event == 'READY':
                            self._session_id = body['session_id']
                            self._user_id = str((body.get('user') or {}).get('id') or '')
                            await self._on_state('connected', '')
                        elif event == 'RESUMED':
                            await self._on_state('connected', '')
                        else:
                            await self._handle_message(event, body)
            except websockets.ConnectionClosed as error:
                if error.code in {4004, 4007, 4009}:
                    self._session_id, self._sequence = '', None
                if error.code == 4004:
                    self._expires = 0
                raise
            finally:
                pulse.cancel()
                await asyncio.gather(pulse, return_exceptions=True)

    async def _handle_message(self, event, body):
        if event not in {'C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'}:
            return
        author = body.get('author') or {}
        if author.get('bot'):
            return
        group = event == 'GROUP_AT_MESSAGE_CREATE'
        sender = author.get('member_openid' if group else 'user_openid') or author.get('id')
        target = body.get('group_openid') if group else sender
        message_id, text = body.get('id'), body.get('content')
        if not all(isinstance(value, str) and value.strip() for value in (sender, target, message_id, text)):
            return
        # QQ normally removes the bot mention prefix itself; accept legacy frames.
        if group and self._user_id:
            text = re.sub(r'^\s*<@!?' + re.escape(self._user_id) + r'>\s*', '', text)
        if not text.strip():
            return
        kind = 'group' if group else 'single'
        self._dispatch(IncomingMessage(self._bot['id'], f'{kind}:{target}:{message_id}', kind,
            target, sender, text.strip(), sender_name=author.get('username') or '',
            reply_context={'msg_id': message_id, 'msg_seq': 0}))

    async def send(self, recipient, message):
        self.validate_outgoing(message)
        group = recipient.conversation_type == 'group'
        path = '/v2/' + ('groups/' if group else 'users/') + quote(recipient.conversation_id, safe='') + '/messages'
        context = recipient.reply_context if isinstance(recipient.reply_context, dict) else {}
        pieces = list(text_chunks(message.text))
        passive = bool(context.get('msg_id'))
        if passive:
            remaining = (5 if group else 4) - context.get('msg_seq', 0)
            if remaining <= 0:
                raise RuntimeError('QQ 被动回复次数已用尽，请在 WorkStep 查看结果')
            if len(pieces) > remaining:
                # Do not silently drop content or switch to permissioned active sends.
                pieces = pieces[:remaining]
                notice = '\n\n内容较长，完整结果请在 WorkStep 查看。'
                pieces[-1] = next(text_chunks(pieces[-1], 1900 - len(notice))) + notice
        for text in pieces:
            body = {'content': text, 'msg_type': 0}
            if passive:
                context['msg_seq'] = context.get('msg_seq', 0) + 1
                body.update(msg_id=context['msg_id'], msg_seq=context['msg_seq'])
            await self._api('POST', path, json=body)

    async def stop(self):
        await super().stop()
        self._token, self._expires = '', 0
        self._session_id, self._sequence = '', None
