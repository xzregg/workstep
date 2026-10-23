"""Slack Socket Mode with prompt envelope acknowledgement."""
import json

import websockets

from services.channels.base import IncomingMessage
from services.channels.social import SocialAdapter, text_chunks


class SlackAdapter(SocialAdapter):
    CHANNEL_ID = 'slack'
    DISPLAY_NAME = 'Slack'

    def __init__(self, *args):
        super().__init__(*args)
        self._user_id = ''

    async def _api(self, method, path, **kwargs):
        token = self._bot['app_token'] if path == 'apps.connections.open' else self._bot['secret']
        return await self._request(method, 'https://slack.com/api/' + path,
                                   headers={'Authorization': 'Bearer ' + token}, **kwargs)

    async def _connect(self):
        identity = await self._api('POST', 'auth.test')
        self._user_id = identity['user_id']
        connection = await self._api('POST', 'apps.connections.open')
        async with websockets.connect(connection['url'], open_timeout=15, max_size=2 * 1024 * 1024) as socket:
            async for raw in socket:
                frame = json.loads(raw)
                if frame.get('type') == 'hello':
                    await self._on_state('connected', '')
                elif frame.get('type') == 'disconnect':
                    return
                else:
                    await self._handle_frame(socket, frame)

    async def _handle_frame(self, socket, frame):
        if frame.get('envelope_id'):
            await socket.send(json.dumps({'envelope_id': frame['envelope_id']}))
        if frame.get('type') != 'events_api':
            return
        payload = frame.get('payload') or {}
        event = payload.get('event') or {}
        if event.get('bot_id') or event.get('subtype') or event.get('user') == self._user_id:
            return
        private = event.get('type') == 'message' and event.get('channel_type') == 'im'
        if not private and event.get('type') != 'app_mention':
            return
        text = (event.get('text') or '').replace(f'<@{self._user_id}>', '').strip()
        if not text or not all(event.get(key) for key in ('channel', 'user', 'ts')):
            return
        self._dispatch(IncomingMessage(
            self._bot['id'], payload.get('event_id') or event['ts'], 'single' if private else 'group',
            event['channel'], event['user'], text,
            reply_context={'thread_ts': event.get('thread_ts') or event['ts']},
        ))

    async def send(self, recipient, message):
        self.validate_outgoing(message)
        for text in text_chunks(message.text, 4000):
            body = {'channel': recipient.conversation_id, 'text': text, 'mrkdwn': False,
                    'unfurl_links': False, 'unfurl_media': False}
            if isinstance(recipient.reply_context, dict) and recipient.reply_context.get('thread_ts'):
                body['thread_ts'] = recipient.reply_context['thread_ts']
            await self._api('POST', 'chat.postMessage', json=body)
