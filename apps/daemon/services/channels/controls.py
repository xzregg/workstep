"""Channel buttons target existing stop, proposal and engine-interaction services."""
from __future__ import annotations

import asyncio
import logging
import time
import uuid

from services.channels.base import ChannelAction, ChannelButton, ChannelCard, IncomingMessage
from services.intervention import intervention_manager

logger = logging.getLogger(__name__)
CONFIG_KEY = 'channel_button_actions'
TTL = 24 * 60 * 60


class ChannelControls:
    def __init__(self, store, load_config, adapters, coordinator, responder, on_message):
        self._store, self._load_config, self._adapters = store, load_config, adapters
        self._coordinator, self._responder, self._on_message = coordinator, responder, on_message
        self._lock = asyncio.Lock()
        self._active = set()
        self._claims = set()

    async def _load(self):
        return await asyncio.to_thread(self._store.get, CONFIG_KEY, {})

    async def _save(self, rows):
        await asyncio.to_thread(self._store.set, CONFIG_KEY, rows)

    async def begin(self, message, project_id, *, task_id='', session_id='', assistant_message_id='', turn_id=''):
        scope = {
            'id': uuid.uuid4().hex, 'project_id': project_id, 'task_id': task_id,
            'session_id': session_id, 'assistant_message_id': assistant_message_id,
            'turn_id': turn_id, 'message': {k: getattr(message, k) for k in ('bot_id','message_id','conversation_type','conversation_id','sender_id','text','sender_name','conversation_name')},
        }
        self._active.add(scope['id'])
        await self._card(scope, '正在处理', '点击停止可中断本次回复。', [('停止', {'kind':'stop'})], recipient_override=message)
        return scope

    async def _card(self, scope, title, text, options, recipient_override=None):
        recipient = recipient_override or IncomingMessage(**scope['message'])
        adapter = self._adapters.get(recipient.bot_id)
        if adapter is None or not getattr(adapter, 'card_enabled', True) or not hasattr(adapter, 'send_card'):
            return
        # Enterprise WeChat supports up to six buttons per card. Keep every
        # option by splitting longer questions into multiple cards.
        for offset in range(0, len(options), 6):
            items = options[offset:offset + 6]
            card_id = uuid.uuid4().hex
            card = ChannelCard(card_id, title, text, tuple(ChannelButton(str(i), label) for i, (label, _) in enumerate(items)), running=all(action["kind"] == "stop" for _, action in items))
            row = {**scope, 'created_at':time.time(), 'status':'pending',
                   'title':title, 'text':text, 'options':{str(i): {'label':label, **action} for i, (label, action) in enumerate(items)}}
            async with self._lock:
                rows = await self._load()
                rows = {k:v for k,v in rows.items() if v.get('status') == 'pending' or v.get('created_at', 0) > time.time() - TTL}
                rows[card_id] = row
                await self._save(rows)
            try:
                await adapter.send_card(recipient, card)
            except Exception:
                logger.exception('Failed to send channel button card')
                async with self._lock:
                    rows = await self._load()
                    rows[card_id]['status'] = 'expired'
                    await self._save(rows)
                try:
                    await adapter.send_text(recipient, '按钮卡片发送失败，请到 WorkStep 对话中操作。')
                except Exception:
                    logger.warning('Failed to send channel card fallback', exc_info=True)

    async def event(self, scope, event):
        if event.get('type') != 'CUSTOM':
            return
        name, data = event.get('name'), event.get('value') or {}
        if name == 'workstep.action_proposal' and scope['task_id'] and data.get('status') == 'pending':
            await self._card(scope, '请确认操作', str((data.get('impact') or {}).get('summary') or data.get('type') or '协调助手提案'),
                [('确认', {'kind':'proposal','proposal_id':data['id'],'confirm':True}),
                 ('取消', {'kind':'proposal','proposal_id':data['id'],'confirm':False})])
        elif name == 'workstep.async_question':
            for index, question in enumerate(data.get('questions', [])):
                if not isinstance(question, dict) or not question.get('title'):
                    continue
                title = str(question['title'])
                options = [(str(value), {'kind':'answer','question_id':f"{data.get('source_item_id', '')}:{index}",'text':f'{title}：{value}'}) for value in question.get('options', []) if isinstance(value, str)]
                if options:
                    await self._card(scope, '请选择', title, options)
        elif name == 'workstep.interaction_request':
            await self._interaction(scope, data)
        elif name == 'workstep.interaction_response':
            await self._expire(scope, interaction_id=data.get('interaction_id'))

    async def _interaction(self, scope, request):
        interaction_id = request.get('interaction_id')
        if not interaction_id:
            return
        options = []
        if request.get('method') == 'session/request_permission':
            title = str((request.get('tool_call') or {}).get('title') or '是否允许操作？')
            for option in request.get('options') or []:
                options.append((str(option.get('name') or option['option_id']), {'kind':'interaction', 'interaction_id':interaction_id,
                    'response':{'outcome':{'outcome':'selected','option_id':option['option_id']}}}))
            cancel = {'outcome':{'outcome':'cancelled'}}
        else:
            title = str(request.get('message') or '请选择')
            properties = (request.get('requested_schema') or {}).get('properties') or {}
            # Single-field enum/boolean questions map directly to buttons. More
            # complex forms retain the existing WorkStep form UI.
            if len(properties) == 1:
                field, prop = next(iter(properties.items()))
                values = prop.get('oneOf') or [{'const':value} for value in prop.get('enum', [])]
                if prop.get('type') == 'boolean':
                    values = [{'const':True,'title':'是'}, {'const':False,'title':'否'}]
                for value in values:
                    options.append((str(value.get('title') or value['const']), {'kind':'interaction','interaction_id':interaction_id,
                        'response':{'action':'accept','content':{field:value['const']}}}))
            cancel = {'action':'cancel'}
        options.append(('取消', {'kind':'interaction','interaction_id':interaction_id,'response':cancel}))
        text = title if len(options) > 1 else title + '\n此问题需要填写表单，请在 WorkStep 中回答，或点击取消。'
        await self._card(scope, '等待你的选择', text, options)

    async def _expire(self, scope, interaction_id=None):
        async with self._lock:
            rows = await self._load()
            expired = []
            for key, row in rows.items():
                if row['id'] != scope['id'] or row['status'] != 'pending':
                    continue
                actions = list(row['options'].values())
                if any(a['kind'] in {'stop','interaction'} and (not interaction_id or a.get('interaction_id') == interaction_id) for a in actions):
                    row['status'] = 'expired'
                    expired.append((key, row))
            await self._save(rows)
        for key, row in expired:
            adapter = self._adapters.get(row['message']['bot_id'])
            if adapter is not None:
                try:
                    await adapter.update_card(IncomingMessage(**row['message']), ChannelCard(key, '已结束', row['text']))
                except Exception:
                    logger.warning('Failed to close channel card', exc_info=True)

    async def finish(self, scope):
        self._active.discard(scope['id'])
        await self._expire(scope)

    async def handle(self, click: ChannelAction, on_claimed=None) -> str:
        async with self._lock:
            rows = await self._load()
            row = rows.get(click.card_id)
            if not row or row.get('status') != 'pending':
                return '该操作已处理或已失效'
            message = row['message']
            if message['bot_id'] != click.bot_id or (click.conversation_id and message['conversation_id'] != click.conversation_id):
                return '该操作不属于此会话'
            if not click.sender_id or message['sender_id'] != click.sender_id:
                return '仅发起此消息的用户可以操作'
            action = row['options'].get(click.key)
            if action is None:
                return '无效的选项'
            identity = tuple(action.get(key) for key in ('kind','interaction_id','proposal_id','question_id'))
            claim = (row['id'], identity)
            if claim in self._claims:
                return '该操作已处理或已失效'
            self._claims.add(claim)
        try:
            config = await self._load_config()
            bot = next((b for b in config['bots'] if b['id'] == click.bot_id and b['enabled']), None)
            if not bot or not self._binding_matches(config, bot, row):
                return '渠道绑定已改变，该操作已失效'
            if action['kind'] in {'stop','interaction'} and row['id'] not in self._active:
                return '该操作已处理或已失效'
            if on_claimed is not None:
                await on_claimed()
            recipient = IncomingMessage(**message)
            from services.channels.bots import _sender_actor
            from services.remote_access import actor_context
            with actor_context(_sender_actor(recipient, bot['platform'])):
                if action['kind'] == 'stop':
                    if row['task_id']:
                        stopped = await self._coordinator.stop_current(row['project_id'], row['task_id'], expected_message_id=row['assistant_message_id'])
                    else:
                        stopped = await self._responder.stop(row['project_id'], row['session_id'], row['assistant_message_id'])
                    result = '已停止' if stopped else '该回复已结束'
                elif action['kind'] == 'interaction':
                    if not intervention_manager.deliver_response(action['interaction_id'], action['response'], task_id=row['turn_id']):
                        return '该问题已回答或已失效'
                    result = '已选择：' + action['label']
                elif action['kind'] == 'proposal':
                    if action['confirm']:
                        await self._coordinator.confirm_action(row['project_id'],row['task_id'],action['proposal_id'],f'channel-card:{click.card_id}')
                    else:
                        await self._coordinator.cancel_action(row['project_id'],row['task_id'],action['proposal_id'])
                    result = '已确认' if action['confirm'] else '已取消'
                else:
                    answer = IncomingMessage(**{**message,'message_id':'card-' + click.card_id, 'text':action['text']})
                    await self._on_message(answer)
                    result = '已选择：' + action['label']
            async with self._lock:
                rows = await self._load()
                # All pages of one question share a decision identity.
                identity = tuple(action.get(key) for key in ('kind','interaction_id','proposal_id','question_id'))
                for other in rows.values():
                    matches = any(tuple(option.get(key) for key in ('kind','interaction_id','proposal_id','question_id')) == identity
                                  for option in other['options'].values())
                    if other['id'] == row['id'] and matches:
                        other['status'] = 'completed'
                await self._save(rows)
            return result
        finally:
            self._claims.discard(claim)

    @staticmethod
    def _binding_matches(config, bot, row):
        message = row['message']
        if row['task_id']:
            binding = next((b for b in config['groups'] if b['bot_id'] == bot['id'] and b['group_id'] == message['conversation_id']), None)
            if binding:
                return (binding['project_id'],binding['task_id']) == (row['project_id'],row['task_id'])
            return (bot.get('default_project_id'),bot.get('default_task_id')) == (row['project_id'],row['task_id'])
        if bot.get('default_task_id') or any(b['bot_id'] == bot['id'] and b['group_id'] == message['conversation_id'] for b in config['groups']):
            return False
        key = f"{bot['id']}:{message['conversation_type']}:{message['conversation_id']}"
        return config['sessions'].get(key) == row['session_id'] and bot.get('default_project_id') == row['project_id']
