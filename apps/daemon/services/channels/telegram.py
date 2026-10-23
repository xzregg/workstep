"""Telegram Bot API long polling; no public callback endpoint required."""
import logging
import re

from services.channels.base import IncomingMessage
from services.channels.social import SocialAdapter, text_chunks


class _RedactToken(logging.Filter):
    def filter(self, record):
        message = record.getMessage()
        redacted = re.sub(r'(https://api\.telegram\.org/bot)[^/\s]+', r'\1[REDACTED]', message)
        if redacted != message:
            record.msg, record.args = redacted, ()
        return True


# HTTPX logs the full request URL at INFO, including Telegram's path token.
logging.getLogger('httpx').addFilter(_RedactToken())


class TelegramAdapter(SocialAdapter):
    CHANNEL_ID = 'telegram'
    DISPLAY_NAME = 'Telegram'

    def __init__(self, *args):
        super().__init__(*args)
        self._username = ''
        self._user_id = self._bot['app_id']
        self._offset = 0

    async def _api(self, method, path, **kwargs):
        data = await self._request(method, f'https://api.telegram.org/bot{self._bot["secret"]}/{path}', **kwargs)
        return data.get('result')

    async def _connect(self):
        identity = await self._api('POST', 'getMe')
        self._username = identity['username']
        self._user_id = str(identity['id'])
        await self._on_state('connected', '')
        while True:
            updates = await self._api('POST', 'getUpdates', json={
                'offset': self._offset, 'timeout': 30, 'allowed_updates': ['message'],
            })
            for update in updates:
                if 'message' in update:
                    await self._handle_message(update['message'])
                self._offset = max(self._offset, update['update_id'] + 1)

    async def _handle_message(self, body):
        sender, chat = body.get('from') or {}, body.get('chat') or {}
        text = body.get('text') or ''
        if sender.get('is_bot') or not sender.get('id') or not text or chat.get('type') not in {'private', 'group', 'supergroup'}:
            return
        group = chat['type'] != 'private'
        reply_sender = (body.get('reply_to_message') or {}).get('from') or {}
        mention = re.compile(r'@' + re.escape(self._username) + r'\b', re.IGNORECASE) if self._username else None
        command = re.compile(r'^/\w+@' + re.escape(self._username) + r'\b', re.IGNORECASE) if self._username else None
        if group and not (mention and mention.search(text)) and str(reply_sender.get('id', '')) != str(self._user_id):
            return
        if command:
            text = command.sub('', text)
        if mention:
            text = mention.sub('', text)
        if not text.strip():
            return
        context = {'message_thread_id': body['message_thread_id']} if body.get('message_thread_id') else None
        self._dispatch(IncomingMessage(
            self._bot['id'], f'{chat["id"]}:{body["message_id"]}', 'group' if group else 'single', str(chat['id']),
            str(sender['id']), text.strip(),
            sender_name=' '.join(filter(None, [sender.get('first_name'), sender.get('last_name')])) or sender.get('username', ''),
            conversation_name=chat.get('title', ''), reply_context=context,
        ))

    async def send(self, recipient, message):
        self.validate_outgoing(message)
        for text in text_chunks(message.text, 4000):
            body = {'chat_id': recipient.conversation_id, 'text': text}
            if isinstance(recipient.reply_context, dict) and recipient.reply_context.get('message_thread_id'):
                body['message_thread_id'] = recipient.reply_context['message_thread_id']
            await self._api('POST', 'sendMessage', json=body)
