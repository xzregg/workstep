"""Explicit channel notifications; no assistant turn or chat message is created."""
from __future__ import annotations

import uuid

from models.chat_session import ChatMessage, ChatSession


class ChannelMessageSender:
    def __init__(self, projects, load_config, adapters):
        self._projects = projects
        self._load = load_config
        self._adapters = adapters

    @staticmethod
    def _recipient(session, route, data):
        bot_id, conversation_type, conversation_id = route.split(':', 2)
        bot = next((bot for bot in data['bots'] if bot['id'] == bot_id), None)
        if bot is None:
            return None
        source = ChatMessage.select(ChatMessage.author_id, ChatMessage.author_name).where(
            (ChatMessage.session == session.id) & (ChatMessage.role == 'user')
            & (ChatMessage.author_device_id == f'channel:{bot_id}')
            & ChatMessage.author_id.startswith('channel:')
        ).order_by(ChatMessage.created_at).first()
        sender_id = source.author_id.split(':', 2)[-1] if source else ''
        peer_name = data.get('session_sources', {}).get(session.id, {}).get('peer_name')
        return {
            'session_id': session.id, 'title': session.title, 'bot_id': bot_id,
            'bot_name': bot['name'], 'platform': bot['platform'], 'enabled': bot['enabled'],
            'conversation_type': conversation_type, 'conversation_id': conversation_id,
            'user_id': sender_id if conversation_type == 'single' else None,
            'peer_name': peer_name or (source.author_name if source and conversation_type == 'single' else conversation_id),
        }

    async def sessions(self, project_id):
        data = await self._load()
        routes = {value: route for route, value in data['sessions'].items()}
        def read(_project):
            results = []
            for session in ChatSession.select().where(
                (ChatSession.project_id == project_id) & (ChatSession.archived == False)
                & ChatSession.id.in_(list(routes))
            ).order_by(ChatSession.updated_at.desc()):
                recipient = self._recipient(session, routes[session.id], data)
                if recipient is not None:
                    results.append(recipient)
            return results
        return {'sessions': await self._projects.run_db(project_id, read)}

    async def send(self, project_id, text, session_id=None, bot_id=None, user_id=None, group_id=None, attachments=None):
        from services.channels.bots import IncomingMessage

        if self._projects.get_project_by_id(project_id) is None:
            raise LookupError("项目不存在")
        data = await self._load()
        if session_id:
            route = next((route for route, value in data['sessions'].items() if value == session_id), None)
            if route is None:
                raise LookupError('渠道会话已重置或不存在')
            def read(_project):
                session = ChatSession.get_or_none((ChatSession.id == session_id) & (ChatSession.project_id == project_id))
                if session is None:
                    raise LookupError('渠道会话不属于此项目')
                if session.archived:
                    raise RuntimeError('渠道会话已归档')
                return self._recipient(session, route, data)
            recipient = await self._projects.run_db(project_id, read)
            if recipient is None:
                raise LookupError('机器人不存在')
            bot_id = recipient['bot_id']
            conversation_type, conversation_id = recipient['conversation_type'], recipient['conversation_id']
            user_id = recipient['user_id'] or ''
        else:
            conversation_type, conversation_id = ('group', group_id) if group_id else ('single', user_id)
        bot = next((bot for bot in data['bots'] if bot['id'] == bot_id), None)
        if bot is None:
            raise LookupError('机器人不存在')
        if not session_id and not (
            bot['default_project_id'] == project_id
            or (group_id and any(binding['bot_id'] == bot_id and binding['group_id'] == group_id
                                 and binding['project_id'] == project_id for binding in data['groups']))
        ):
            raise PermissionError('机器人或群聊不属于此项目')
        adapter = self._adapters.get(bot_id)
        if not bot['enabled'] or adapter is None:
            raise RuntimeError('机器人未启用或尚未连接')
        message_id = str(uuid.uuid4())
        recipient = IncomingMessage(
            bot_id=bot_id, message_id=message_id, conversation_type=conversation_type,
            conversation_id=conversation_id, sender_id=user_id or '', text='',
        )
        from services.channels.base import ChannelAdapter
        if isinstance(adapter, ChannelAdapter):
            from services.channels.media import outgoing_content
            project = self._projects.get_project_by_id(project_id)
            outgoing = await outgoing_content(project, adapter, text, attachments or ())
            await adapter.send(recipient, outgoing)
        elif attachments:
            raise ValueError('渠道不支持附件')
        else:
            await adapter.send_text(recipient, text)
        return {'ok': True, 'sent': True, 'message_id': message_id, 'bot_id': bot_id,
                'platform': bot['platform'], 'conversation_type': conversation_type,
                'conversation_id': conversation_id}
