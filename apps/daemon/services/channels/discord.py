"""Discord Gateway text messages and REST replies."""
import asyncio
import json
import random
import re
from urllib.parse import quote

import websockets

from services.channels.base import IncomingMessage
from services.channels.social import SocialAdapter, text_chunks


class DiscordAdapter(SocialAdapter):
    CHANNEL_ID = 'discord'
    DISPLAY_NAME = 'Discord'

    def __init__(self, *args):
        super().__init__(*args)
        self._user_id = self._bot['app_id']
        self._sequence = None
        self._session_id = ''
        self._resume_url = ''

    async def _api(self, method, path, **kwargs):
        return await self._request(method, 'https://discord.com/api/v10' + path,
                                   headers={'Authorization': 'Bot ' + self._bot['secret']}, **kwargs)

    async def _connect(self):
        identity = await self._api('GET', '/users/@me')
        self._user_id = identity['id']
        gateway = await self._api('GET', '/gateway/bot')
        uri = (self._resume_url or gateway['url']) + '?v=10&encoding=json'
        async with websockets.connect(uri, open_timeout=15, max_size=2 * 1024 * 1024) as socket:
            hello = json.loads(await asyncio.wait_for(socket.recv(), 15))
            if hello.get('op') != 10:
                raise RuntimeError('Discord 握手失败')
            interval = hello['d']['heartbeat_interval'] / 1000
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
                    await socket.send(json.dumps({'op': 6, 'd': {'token': self._bot['secret'],
                        'session_id': self._session_id, 'seq': self._sequence}}))
                else:
                    await socket.send(json.dumps({'op': 2, 'd': {'token': self._bot['secret'],
                        'intents': (1 << 9) | (1 << 12) | (1 << 15),
                        'properties': {'os': 'linux', 'browser': 'WorkStep', 'device': 'WorkStep'}}}))
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
                            self._session_id, self._resume_url, self._sequence = '', '', None
                        return
                    elif operation == 0:
                        event, body = frame.get('t'), frame.get('d') or {}
                        if event == 'READY':
                            self._session_id, self._resume_url = body['session_id'], body['resume_gateway_url']
                            await self._on_state('connected', '')
                        elif event == 'RESUMED':
                            await self._on_state('connected', '')
                        elif event == 'MESSAGE_CREATE':
                            await self._handle_message(body)
            except websockets.ConnectionClosed as error:
                if error.code in {4007, 4009}:
                    self._session_id, self._resume_url, self._sequence = '', '', None
                raise
            finally:
                pulse.cancel()
                await asyncio.gather(pulse, return_exceptions=True)

    async def _handle_message(self, body):
        author = body.get('author') or {}
        if author.get('bot') or body.get('webhook_id') or not body.get('content'):
            return
        group = bool(body.get('guild_id'))
        if group and not any(str(user.get('id')) == self._user_id for user in body.get('mentions', [])):
            return
        text = re.sub(r'<@!?' + re.escape(self._user_id) + '>', '', body['content']).strip()
        if text and all(body.get(key) for key in ('id', 'channel_id')) and author.get('id'):
            self._dispatch(IncomingMessage(
                self._bot['id'], body['id'], 'group' if group else 'single', body['channel_id'], author['id'], text,
                sender_name=(body.get('member') or {}).get('nick') or author.get('global_name') or author.get('username', ''),
            ))

    async def send(self, recipient, message):
        self.validate_outgoing(message)
        for text in text_chunks(message.text):
            await self._api('POST', '/channels/' + quote(recipient.conversation_id, safe='') + '/messages',
                            json={'content': text, 'allowed_mentions': {'parse': []}})
