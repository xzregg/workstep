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
        from services.channels.sender import ChannelMessageSender
        self._sender = ChannelMessageSender(project_manager, load_config, adapters)
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
        project_id, session_id, message_id = (event.get(key) for key in ('project_id', 'session_id', 'messageId'))
        key = (project_id, session_id, message_id)
        if not all(key) or key in self._sent:
            return
        data = await self._load()
        route = next((route for route, value in data['sessions'].items() if value == session_id), None)
        if not route:
            return
        def read_reply(_project):
            message = ChatMessage.get_or_none((ChatMessage.id == message_id) & (ChatMessage.session == session_id))
            session = ChatSession.get_or_none((ChatSession.id == session_id) & (ChatSession.project_id == project_id))
            if message is None or session is None or session.archived or message.role != 'assistant':
                return None
            # Inbound turns already reply through their callback, including the first turn.
            if (message.author_device_id or '').startswith('channel:'):
                return None
            return message.content

        reply = await self._projects.run_db(project_id, read_reply)
        if reply is None:
            return
        text = reply
        if not text.strip():
            return
        await self._sender.send(project_id, text, session_id=session_id)
        self._sent.append(key)
