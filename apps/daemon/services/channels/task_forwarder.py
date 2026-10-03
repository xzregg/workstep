"""Broadcast live task LLM text to current bot/group bindings."""
from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass, field, replace
import logging
import uuid

from models.message import Message
from models.task import Task
from services.channels.base import ChannelAdapter, IncomingMessage, OutgoingMessage
from services.workflow_definition import WorkflowDefinition

logger = logging.getLogger(__name__)
MESSAGE_EVENTS = {'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CHUNK', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END'}


@dataclass
class _LiveMessage:
    key: tuple[str, str, str]
    text: str = ''
    status: str = ''
    error: str = ''
    final_content: bool = False
    revision: int = 0
    sequences: dict[str, int] = field(default_factory=dict)
    wakes: list[asyncio.Event] = field(default_factory=list)
    job: asyncio.Task | None = None


class ChannelTaskForwarder:
    def __init__(self, event_bus, project_manager, load_config, adapters, *, interval=2):
        self._bus, self._projects, self._load, self._adapters = event_bus, project_manager, load_config, adapters
        self._interval = interval
        self._queue = self._task = None
        self._messages: dict[tuple[str, str, str], _LiveMessage] = {}
        self._jobs = set()
        self._origins = {}
        self._completed = deque(maxlen=2000)

    @property
    def running(self):
        return self._task is not None

    async def start(self):
        if self._task is not None:
            return
        self._queue = self._bus.subscribe(lambda event: (
            event.get('type') in MESSAGE_EVENTS and bool(event.get('project_id'))
            and bool(event.get('task_id')) and bool(event.get('messageId'))
        ))
        self._task = asyncio.create_task(self._run())

    async def shutdown(self):
        if self._queue is not None:
            self._bus.unsubscribe(self._queue)
        jobs = [self._task] if self._task else []
        jobs += list(self._jobs)
        for job in jobs:
            job.cancel()
        if jobs:
            await asyncio.gather(*jobs, return_exceptions=True)
        for _, future in self._origins.values():
            if not future.done():
                future.cancel()
        self._origins.clear()
        self._messages.clear()
        self._jobs.clear()
        self._queue = self._task = None

    def register_origin(self, project_id, task_id, message_id, message):
        """Register before yielding after submit_message; preserve inbound stream context."""
        if self._task is None:
            return False
        key = (project_id, task_id, message_id)
        if key not in self._origins:
            self._origins[key] = (message, asyncio.get_running_loop().create_future())
        return True

    async def wait(self, project_id, task_id, message_id):
        origin = self._origins.get((project_id, task_id, message_id))
        if origin:
            await asyncio.shield(origin[1])

    async def _run(self):
        while True:
            event = await self._queue.get()
            if event is None:
                return
            key = tuple(event[name] for name in ('project_id', 'task_id', 'messageId'))
            retry = event['type'] == 'TEXT_MESSAGE_START' and event.get('retry')
            previous = self._messages.get(key)
            if retry and (key in self._completed or (previous and previous.status)):
                if previous:
                    previous.final_content = True
                self._messages.pop(key, None)
                while key in self._completed:
                    self._completed.remove(key)
            if key in self._completed or event.get('role') == 'user':
                continue
            state = self._messages.get(key)
            if state is None:
                state = self._messages[key] = _LiveMessage(key)
                state.job = asyncio.create_task(self._forward(state))
                self._jobs.add(state.job)
                state.job.add_done_callback(self._jobs.discard)
            if state.status:
                continue
            kind = event['type']
            sequence = event.get('sequence')
            if isinstance(sequence, int):
                if sequence <= state.sequences.get(kind, -1):
                    continue
                state.sequences[kind] = sequence
            if kind == 'TEXT_MESSAGE_CHUNK':
                state.text += str(event.get('delta') or '')
            elif kind == 'TEXT_MESSAGE_CONTENT' or kind == 'TEXT_MESSAGE_START':
                if event.get('content') is not None:
                    state.text = str(event['content'])
            elif kind == 'TEXT_MESSAGE_END':
                state.status = event.get('status') or 'succeeded'
                state.error = str(event.get('error') or '')
                state.final_content = event.get('content') is not None
                if state.final_content:
                    state.text = str(event['content'])
            state.revision += 1
            for wake in state.wakes:
                wake.set()

    async def _metadata(self, state):
        project_id, task_id, message_id = state.key
        def read(project):
            message = Message.get_or_none((Message.id == message_id) & (Message.task == task_id))
            task = Task.get_or_none(Task.id == task_id)
            if message is None or message.role != 'assistant' or task is None or task.archived:
                return None
            if message.channel == 'coordinator':
                title = '协调'
            else:
                workflow = project.workflow_by_id(task.workflow_id)
                definition = workflow['steps'] if workflow else project.steps
                steps = WorkflowDefinition.load(definition).compile().steps
                step = next((row for row in steps if str(row['key']) == message.step_key), {})
                title = step.get('label') or '未命名阶段'
                if message.channel == 'review':
                    title += ' · 审核'
            return str(title).replace('\n', ' ').replace('\r', ' ')
        return await self._projects.run_db(project_id, read)

    async def _forward(self, state):
        try:
            project_id, task_id, _ = state.key
            data = await self._load()
            bindings = [row for row in data['groups'] if row['project_id'] == project_id and row['task_id'] == task_id]
            origin = self._origins.get(state.key)
            if origin and not any((b['bot_id'], b['group_id']) == (origin[0].bot_id, origin[0].conversation_id) for b in bindings):
                # Legacy default-task routing can also originate from a private chat.
                bindings.append({'bot_id':origin[0].bot_id, 'group_id':origin[0].conversation_id})
            if not bindings:
                return
            title = await self._metadata(state)
            if title is None:
                return
            destinations = {(row['bot_id'], row['group_id']) for row in bindings}
            await asyncio.gather(*(self._deliver(state, title, bot_id, group_id) for bot_id, group_id in destinations))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception('Failed to route task channel message %s', state.key)
        finally:
            if self._messages.get(state.key) is state:
                self._messages.pop(state.key, None)
                self._completed.append(state.key)
                origin = self._origins.pop(state.key, None)
                if origin and not origin[1].done():
                    origin[1].set_result(None)

    async def _recipient(self, state, bot_id, group_id):
        data = await self._load()
        bot = next((b for b in data['bots'] if b['id'] == bot_id and b['enabled']), None)
        adapter = self._adapters.get(bot_id)
        if bot is None or adapter is None:
            return None
        project_id, task_id, message_id = state.key
        bound = any((b['bot_id'], b['group_id'], b['project_id'], b['task_id']) == (bot_id, group_id, project_id, task_id) for b in data['groups'])
        origin = self._origins.get(state.key)
        original = origin[0] if origin and (origin[0].bot_id, origin[0].conversation_id) == (bot_id, group_id) else None
        if not bound and not (original and (bot.get('default_project_id'), bot.get('default_task_id')) == (project_id, task_id)):
            return None
        recipient = original or IncomingMessage(bot_id, uuid.uuid5(uuid.NAMESPACE_URL, ':'.join(state.key) + ':' + bot_id + ':' + group_id).hex,
                                                 'group', group_id, '', '')
        return adapter, recipient

    async def _final_text(self, state):
        if state.final_content:
            return state.text
        def read(_project):
            message = Message.get_or_none((Message.id == state.key[2]) & (Message.task == state.key[1]))
            return message.content if message else state.text
        return await self._projects.run_db(state.key[0], read)

    async def _send(self, adapter, recipient, project_id, text, *, full_text=None):
        if not isinstance(adapter, ChannelAdapter):
            await adapter.send_text(recipient, text)
            return
        outgoing = OutgoingMessage(text=text)
        if full_text:
            from services.channels.media import outgoing_content
            project = self._projects.get_project_by_id(project_id)
            prepared = await outgoing_content(project, adapter, full_text)
            outgoing = replace(outgoing, text=text.replace(full_text, prepared.text, 1), attachments=prepared.attachments)
        await adapter.send(recipient, outgoing)

    async def _progress(self, adapter, recipient, state, text):
        try:
            await asyncio.wait_for(adapter.update_reply(recipient, text), 5)
            return True
        except Exception:
            logger.warning('Task channel progress failed; final delivery will retry %s', state.key, exc_info=True)
            return False

    async def _deliver(self, state, title, bot_id, group_id):
        wake = asyncio.Event()
        state.wakes.append(wake)
        sent = ''
        adapter = recipient = None
        prefix = '@' + title + '\n'
        try:
            destination = await self._recipient(state, bot_id, group_id)
            if destination is None:
                return
            adapter, recipient = destination
            supports_streaming = getattr(adapter, 'supports_streaming_reply', None)
            streaming = supports_streaming(recipient) if supports_streaming else bool(recipient.reply_context and getattr(getattr(adapter, 'CAPABILITIES', None), 'streaming', False))
            progress_active = streaming and await self._progress(adapter, recipient, state, prefix + '正在执行…')
            interval = min(self._interval, .5) if streaming else self._interval
            last_sent = asyncio.get_running_loop().time() - interval if streaming else asyncio.get_running_loop().time()
            revision = 0
            while True:
                if not progress_active and not state.status:
                    # Platforms without editable replies receive only the final body.
                    # Do not repeatedly reload disk configuration for every chunk.
                    wake.clear()
                    await wake.wait()
                    continue
                if not state.status and state.revision == revision:
                    wake.clear()
                    await wake.wait()
                if not state.status:
                    delay = interval - (asyncio.get_running_loop().time() - last_sent)
                    if delay > 0 and not state.status:
                        # Coalesce snapshots until the interval elapses, unless ending.
                        while not state.status and asyncio.get_running_loop().time() - last_sent < interval:
                            wake.clear()
                            try:
                                await asyncio.wait_for(wake.wait(), interval - (asyncio.get_running_loop().time() - last_sent))
                            except TimeoutError:
                                break
                destination = await self._recipient(state, bot_id, group_id)
                if destination is None:
                    return
                adapter, recipient = destination
                if state.status:
                    text = await self._final_text(state)
                    suffix = {'succeeded':'已完成', 'stopped':'已停止', 'cancelled':'已停止'}.get(state.status, '执行失败' + ('：' + state.error if state.error else ''))
                    final = prefix + (text + '\n\n' if text else '') + suffix
                    await asyncio.wait_for(self._send(adapter, recipient, state.key[0], final, full_text=text), 30)
                    return
                text = state.text
                revision = state.revision
                if progress_active and text and text != sent:
                    progress_active = await self._progress(adapter, recipient, state, prefix + text)
                    if progress_active:
                        sent = text
                    last_sent = asyncio.get_running_loop().time()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception('Failed to forward task message %s to %s/%s', state.key, bot_id, group_id)
            await self._bus.publish({'type':'CUSTOM', 'name':'channel_bots.reply_error',
                                     'project_id':state.key[0], 'task_id':state.key[1],
                                     'value':{'message_id':state.key[2], 'bot_id':bot_id, 'group_id':group_id,
                                              'error':'任务消息推送失败，请检查机器人连接及发送权限。'}})
        finally:
            if isinstance(adapter, ChannelAdapter) and recipient is not None:
                adapter.release_reply(recipient)
            state.wakes.remove(wake)
