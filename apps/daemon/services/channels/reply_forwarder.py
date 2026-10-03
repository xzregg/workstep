"""Send completed WorkStep chat replies to their current channel mapping."""
from __future__ import annotations

import asyncio
from collections import deque
import logging

from models.chat_session import ChatMessage, ChatSession

logger = logging.getLogger(__name__)


class ChannelReplyForwarder:
    def __init__(self, event_bus, project_manager, load_config, adapters):
        self._bus = event_bus
        self._projects = project_manager
        self._load = load_config
        self._adapters = adapters
        self._queue = None
        self._task = None
        self._sent = deque(maxlen=1000)

    async def start(self):
        if self._task is not None:
            return
        self._queue = self._bus.subscribe(lambda event: (
            event.get('type') == 'TEXT_MESSAGE_END'
            and bool(event.get('session_id'))
            and event.get('status') == 'succeeded'
        ))
        self._task = asyncio.create_task(self._run())

    async def shutdown(self):
        if self._queue is not None:
            self._bus.unsubscribe(self._queue)
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._queue = self._task = None

    async def _run(self):
        while True:
            event = await self._queue.get()
            if event is None:
                return
            try:
                await self._forward(event)
            except Exception:
                logger.exception('Failed to forward channel reply %s', event.get('messageId'))
                await self._bus.publish({
                    'type': 'CUSTOM', 'name': 'channel_bots.reply_error',
                    'session_id': event.get('session_id'), 'project_id': event.get('project_id'),
                    'value': {'message_id': event.get('messageId'), 'error': '渠道回复推送失败，请检查机器人连接及发送权限。'},
                })

    async def _forward(self, event):
        from services.channels.bots import IncomingMessage

        project_id, session_id, message_id = (event.get(key) for key in ('project_id', 'session_id', 'messageId'))
        key = (project_id, session_id, message_id)
        if not all(key) or key in self._sent:
            return
        data = await self._load()
        route = next((route for route, value in data['sessions'].items() if value == session_id), None)
        if not route:
            return
        bot_id, conversation_type, conversation_id = route.split(':', 2)
        bot = next((bot for bot in data['bots'] if bot['id'] == bot_id and bot['enabled']), None)
        adapter = self._adapters.get(bot_id)
        if bot is None or adapter is None:
            return

        def read_reply(_project):
            message = ChatMessage.get_or_none((ChatMessage.id == message_id) & (ChatMessage.session == session_id))
            session = ChatSession.get_or_none((ChatSession.id == session_id) & (ChatSession.project_id == project_id))
            if message is None or session is None or session.archived or message.role != 'assistant':
                return None
            # Inbound turns already reply through their callback, including the first turn.
            if (message.author_device_id or '').startswith('channel:'):
                return None
            sender = ChatMessage.select(ChatMessage.author_id).where(
                (ChatMessage.session == session_id) & (ChatMessage.role == 'user')
                & (ChatMessage.author_device_id == f'channel:{bot_id}')
                & ChatMessage.author_id.startswith('channel:')
            ).order_by(ChatMessage.created_at).first()
            return message.content, sender.author_id.split(':', 2)[-1] if sender else ''

        reply = await self._projects.run_db(project_id, read_reply)
        if reply is None:
            return
        text, sender_id = reply
        if not text.strip():
            return
        await adapter.send_text(IncomingMessage(
            bot_id=bot_id, message_id=message_id, conversation_type=conversation_type,
            conversation_id=conversation_id, sender_id=sender_id, text='',
        ), text)
        self._sent.append(key)
