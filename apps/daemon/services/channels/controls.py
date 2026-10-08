"""Channel buttons target existing stop, proposal and engine-interaction services."""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import replace

from services.channels.base import ChannelAction, ChannelButton, ChannelCard, IncomingMessage
from services.intervention import intervention_manager

logger = logging.getLogger(__name__)
CONFIG_KEY = 'channel_button_actions'
TTL = 24 * 60 * 60


class ChannelControls:
    def __init__(self, store, load_config, adapters, coordinator, responder, on_message, *, workflow_runtime=None, projects=None):
        self._store, self._load_config, self._adapters = store, load_config, adapters
        self._coordinator, self._responder, self._on_message = coordinator, responder, on_message
        self._workflow_runtime = workflow_runtime
        self._projects = projects
        self._lock = asyncio.Lock()
        self._active = set()
        self._running_scopes = {}
        self._reply_texts = {}
        self._claims = set()

    async def _load(self):
        return await asyncio.to_thread(self._store.get, CONFIG_KEY, {})

    async def _save(self, rows):
        await asyncio.to_thread(self._store.set, CONFIG_KEY, rows)

    async def begin(self, message, project_id, *, task_id='', session_id='', assistant_message_id='', turn_id='', step_key='', broadcast=False, title='回复控制', stop_button=True):
        key = (project_id, task_id, session_id, assistant_message_id,
               message.bot_id, message.conversation_type, message.conversation_id)
        existing = self._running_scopes.get(key) if assistant_message_id else None
        if existing is not None:
            scope, ready = existing
            await asyncio.shield(ready)
            return scope
        scope = {
            'id': uuid.uuid4().hex, 'project_id': project_id, 'task_id': task_id,
            'session_id': session_id, 'assistant_message_id': assistant_message_id,
            'turn_id': turn_id, 'step_key':step_key, 'broadcast':broadcast, 'message': {k: getattr(message, k) for k in ('bot_id','message_id','conversation_type','conversation_id','sender_id','text','sender_name','conversation_name')},
        }
        self._active.add(scope['id'])
        ready = asyncio.get_running_loop().create_future()
        if assistant_message_id:
            # Register before I/O so the inbound route and task broadcaster
            # share the same control even while its first send is pending.
            self._running_scopes[key] = (scope, ready)
        text = '点击中止可停止本次运行。'
        if assistant_message_id:
            text += '\n消息 ID: ' + assistant_message_id
        try:
            if stop_button:
                adapter = self._adapters.get(message.bot_id)
                prepare = getattr(adapter, 'set_reply_metadata', None)
                if prepare:
                    metadata = {'assistant': '协调助手' if task_id else '渠道助手'}
                    if task_id and hasattr(self._coordinator, 'get_config'):
                        try:
                            resolved = (await self._coordinator.get_config(project_id, task_id)).get('resolved', {})
                            metadata.update({k: resolved.get(k) or '' for k in ('engine', 'model', 'thinking_effort')})
                        except Exception:
                            logger.warning('Failed to read channel card execution metadata', exc_info=True)
                    elif not task_id and hasattr(self._responder, 'reply_metadata'):
                        metadata.update(self._responder.reply_metadata(turn_id))
                    prepare(message, metadata)
                await self._card(scope, title, text, [('中止', {'kind':'stop'})], recipient_override=message)
        except BaseException:
            ready.cancel()
            self._running_scopes.pop(key, None)
            self._active.discard(scope['id'])
            raise
        ready.set_result(None)
        return scope

    async def review(self, scope, review_id, title, text):
        await self._card(scope, title + ' · 等待审核', text + '\n需要填写审核意见时，请到 WorkStep 审核表单操作。',
            [('通过', {'kind':'review', 'review_id':review_id, 'decision':'approve'}),
             ('不通过', {'kind':'review', 'review_id':review_id, 'decision':'reject'})])

    async def _review_pending(self, row, action):
        if self._projects is None:
            return False
        from models import ReviewRun, Task
        def read(_project):
            task = Task.get_or_none(Task.id == row['task_id'])
            latest = (ReviewRun.select().where((ReviewRun.task == row['task_id']) &
                (ReviewRun.step_key == row['step_key']))
                .order_by(ReviewRun.started_at.desc(), ReviewRun.id.desc()).first())
            return bool(task and not task.archived and latest and latest.id == action['review_id']
                and latest.mode == 'manual' and latest.status == 'pending' and not latest.decision
                and task.active_workflow_run_id == latest.workflow_run_id)
        return await self._projects.run_db(row['project_id'], read)

    async def _card(self, scope, title, text, options, recipient_override=None, dedup_key=None):
        recipient = recipient_override or IncomingMessage(**scope['message'])
        adapter = self._adapters.get(recipient.bot_id)
        if adapter is None or not getattr(adapter, 'card_enabled', True) or not hasattr(adapter, 'send_card'):
            return
        # Enterprise WeChat supports up to six buttons per card. Keep every
        # option by splitting longer questions into multiple cards.
        for offset in range(0, len(options), 6):
            items = options[offset:offset + 6]
            card_id = uuid.uuid4().hex
            card = ChannelCard(card_id, title, text, tuple(ChannelButton(str(i), label, danger=action['kind'] == 'stop') for i, (label, action) in enumerate(items)), running=all(action["kind"] == "stop" for _, action in items), message_id=scope.get('assistant_message_id', ''))
            page_key = f'{dedup_key}:{offset}' if dedup_key else None
            row = {**scope, 'created_at':time.time(), 'status':'pending', 'event_key':page_key,
                   'title':title, 'text':text, 'options':{str(i): {'label':label, **action} for i, (label, action) in enumerate(items)}}
            async with self._lock:
                rows = await self._load()
                rows = {k:v for k,v in rows.items() if v.get('status') == 'pending' or v.get('created_at', 0) > time.time() - TTL}
                if page_key and any(
                    other.get('event_key') == page_key and
                    (other['project_id'], other['task_id'], other['assistant_message_id'],
                     other['message']['bot_id'], other['message']['conversation_type'], other['message']['conversation_id']) ==
                    (scope['project_id'], scope['task_id'], scope['assistant_message_id'],
                     recipient.bot_id, recipient.conversation_type, recipient.conversation_id)
                    for other in rows.values()):
                    continue
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
        if event.get('messageId') and event['messageId'] != scope['assistant_message_id']:
            return
        adapter = self._adapters.get(scope['message']['bot_id'])
        observe = getattr(adapter, 'observe_reply', None)
        if observe:
            observe(IncomingMessage(**scope['message']), event)
        kind = event.get('type')
        if kind == 'TEXT_MESSAGE_CHUNK':
            self._reply_texts[scope['id']] = (self._reply_texts.get(scope['id'], '') + str(event.get('delta') or ''))[-4096:]
        elif kind in {'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END'} and event.get('content') is not None:
            self._reply_texts[scope['id']] = str(event['content'])[-4096:]
        if event.get('type') != 'CUSTOM':
            return
        name, data = event.get('name'), event.get('value') or {}
        if name == 'workstep.action_proposal' and scope['task_id'] and data.get('status') == 'pending':
            description = self._reply_texts.get(scope['id'], '').strip() or str((data.get('impact') or {}).get('summary') or data.get('type') or '协调助手提案')
            await self._card(scope, '请确认操作', description,
                [('确认', {'kind':'proposal','proposal_id':data['id'],'confirm':True}),
                 ('取消', {'kind':'proposal','proposal_id':data['id'],'confirm':False})])
        elif name == 'workstep.async_question':
            for index, question in enumerate(data.get('questions', [])):
                if not isinstance(question, dict) or not question.get('title'):
                    continue
                title = str(question['title'])
                options = [(str(value), {'kind':'answer','question_id':f"{data.get('source_item_id', '')}:{index}",'text':f'{title}：{value}'}) for value in question.get('options', []) if isinstance(value, str)]
                if options:
                    await self._card(scope, '请选择', title, options,
                        dedup_key=f"question:{data.get('source_item_id') or scope['assistant_message_id']}:{index}")
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
                actions = list(row['options'].values())
                completed_stop = not interaction_id and row['status'] == 'completed' and any(a['kind'] == 'stop' for a in actions)
                if row['id'] != scope['id'] or (row['status'] != 'pending' and not completed_stop):
                    continue
                if any(a['kind'] in {'stop','interaction'} and (not interaction_id or a.get('interaction_id') == interaction_id) for a in actions):
                    row['status'] = 'expired'
                    expired.append((key, row))
            await self._save(rows)
        for key, row in expired:
            adapter = self._adapters.get(row['message']['bot_id'])
            if adapter is not None:
                try:
                    await adapter.update_card(IncomingMessage(**row['message']), ChannelCard(key, '已结束', row['text'], running=any(a['kind'] == 'stop' for a in row['options'].values()), message_id=row.get('assistant_message_id', '')))
                except Exception:
                    logger.warning('Failed to close channel card', exc_info=True)

    async def finish(self, scope):
        if scope['id'] not in self._active:
            return
        self._active.discard(scope['id'])
        self._reply_texts.pop(scope['id'], None)
        for key, (current, _) in tuple(self._running_scopes.items()):
            if current is scope:
                self._running_scopes.pop(key, None)
        await self._expire(scope)

    async def handle(self, click: ChannelAction, on_claimed=None) -> str:
        async with self._lock:
            rows = await self._load()
            row = rows.get(click.card_id)
            if not row or row.get('status') != 'pending':
                if row and row['message']['bot_id'] == click.bot_id and (
                    not click.conversation_id or row['message']['conversation_id'] == click.conversation_id):
                    actor = row.get('clicked_by') or {}
                    name = actor.get('user_name') or actor.get('user_id')
                    if name:
                        return f'该操作已处理或已失效（操作人：{name}）'
                return '该操作已处理或已失效'
            message = row['message']
            if message['bot_id'] != click.bot_id or (click.conversation_id and message['conversation_id'] != click.conversation_id):
                return '该操作不属于此会话'
            action = row['options'].get(click.key)
            if click.key == 'stop':
                action = next((option for option in row['options'].values() if option['kind'] == 'stop'), None)
            broadcast_action = row.get('broadcast') and action and action['kind'] in {'stop','review','interaction','answer'}
            if broadcast_action and click.conversation_id != message['conversation_id']:
                return '该操作不属于此会话'
            if not click.sender_id or (not broadcast_action and message['sender_id'] != click.sender_id):
                return '仅发起此消息的用户可以操作'
            if action is None:
                return '无效的选项'
            identity = tuple(action.get(key) for key in ('kind','interaction_id','proposal_id','question_id','review_id'))
            shared_answer = action and action['kind'] == 'answer' and bool(row['task_id'])
            claim_scope = (row['project_id'], row['task_id'], row['assistant_message_id']) if broadcast_action or shared_answer else row['id']
            claim = (claim_scope, identity)
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
            if action['kind'] == 'review' and not await self._review_pending(row, action):
                return '该审核已处理或已失效'
            if on_claimed is not None:
                await on_claimed()
            recipient = IncomingMessage(**message)
            recipient = replace(recipient, sender_id=click.sender_id,
                sender_name=click.sender_name or (message.get('sender_name') if message['sender_id'] == click.sender_id else '') or click.sender_id)
            from services.channels.bots import _sender_actor
            from services.remote_access import actor_context
            with actor_context(_sender_actor(recipient, bot['platform'])):
                if action['kind'] == 'stop':
                    if row.get('step_key'):
                        stopped = await self._workflow_runtime.cancel_message(row['project_id'], row['task_id'], row['assistant_message_id']) if self._workflow_runtime else False
                    elif row['task_id']:
                        stopped = await self._coordinator.stop_current(row['project_id'], row['task_id'], expected_message_id=row['assistant_message_id'])
                    else:
                        stopped = await self._responder.stop(row['project_id'], row['session_id'], row['assistant_message_id'])
                    result = '已停止' if stopped else '该回复已结束'
                elif action['kind'] == 'review':
                    if self._workflow_runtime is None:
                        return '审核服务不可用，请到 WorkStep 操作'
                    await self._workflow_runtime.decide_review(row['project_id'], row['task_id'], row['step_key'],
                        action['review_id'], action['decision'])
                    result = recipient.sender_name + (' 审核通过' if action['decision'] == 'approve' else ' 审核不通过')
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
                    answer = replace(recipient, message_id='card-' + click.card_id, text=action['text'])
                    await self._on_message(answer)
                    result = '已选择：' + action['label']
            async with self._lock:
                rows = await self._load()
                # All pages of one question share a decision identity.
                identity = tuple(action.get(key) for key in ('kind','interaction_id','proposal_id','question_id','review_id'))
                for other in rows.values():
                    matches = any(tuple(option.get(key) for key in ('kind','interaction_id','proposal_id','question_id','review_id')) == identity
                                  for option in other['options'].values())
                    same_scope = other['id'] == row['id'] or ((shared_answer or (broadcast_action and other.get('broadcast'))) and
                        (other['project_id'],other['task_id'],other['assistant_message_id']) == claim_scope)
                    if same_scope and matches:
                        other['status'] = 'completed'
                        other['clicked_by'] = {'user_id':click.sender_id, 'user_name':recipient.sender_name, 'at':time.time()}
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
