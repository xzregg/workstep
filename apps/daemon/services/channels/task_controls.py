"""Forward automatic-step questions and manual reviews to bound discussion groups."""
from __future__ import annotations

import asyncio
from collections import deque
import logging

from models import Message, ReviewRun, Task
from services.channels.base import IncomingMessage
from services.workflow_definition import WorkflowDefinition

logger = logging.getLogger(__name__)
NAMES = {'workstep.review_result', 'workstep.review_status',
         'workstep.interaction_request', 'workstep.interaction_response', 'workstep.async_question'}


class ChannelTaskControls:
    def __init__(self, bus, projects, load_config, controls):
        self._bus, self._projects, self._load, self._controls = bus, projects, load_config, controls
        self._queue = self._task = None
        self._jobs, self._tails, self._scopes = set(), {}, {}
        self._seen = deque(maxlen=2000)

    async def start(self):
        if self._task is not None:
            return
        self._queue = self._bus.subscribe(lambda e: bool(e.get('project_id') and e.get('task_id')) and (
            (e.get('type') == 'CUSTOM' and e.get('name') in NAMES and e.get('channel') != 'coordinator')
            or e.get('type') in {'TEXT_MESSAGE_END','RUN_ERROR'}))
        self._task = asyncio.create_task(self._run())

    async def shutdown(self):
        if self._queue is not None:
            self._bus.unsubscribe(self._queue)
        jobs = list(self._jobs) + ([self._task] if self._task else [])
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)
        for scope in list(self._scopes.values()):
            await self._controls.finish(scope)
        self._scopes.clear()
        self._tails.clear()
        self._jobs.clear()
        self._seen.clear()
        self._queue = self._task = None

    async def _run(self):
        while True:
            event = await self._queue.get()
            if event is None:
                return
            key = (event['project_id'], event['task_id'])
            previous = self._tails.get(key)
            job = asyncio.create_task(self._ordered(key, previous, event))
            self._tails[key] = job
            self._jobs.add(job)
            job.add_done_callback(self._jobs.discard)

    async def _ordered(self, key, previous, event):
        try:
            if previous:
                await previous
            await self._handle(event)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception('Failed to forward automatic task controls %s', key)
        finally:
            if self._tails.get(key) is asyncio.current_task():
                self._tails.pop(key, None)

    async def _metadata(self, event):
        data = event.get('value') or {}
        def read(project):
            task = Task.get_or_none(Task.id == event['task_id'])
            if task is None or task.archived:
                return None
            step_key = event.get('step_key') or data.get('step_key') or ''
            review_id = data.get('review_run_id')
            if review_id:
                review = ReviewRun.get_or_none((ReviewRun.id == review_id) & (ReviewRun.task == task.id))
                if not review or review.mode != 'manual' or review.status != 'pending' or review.decision:
                    return None
                step_key = review.step_key
                message = (Message.select().where((Message.task == task.id) & (Message.step_run_id == review.step_run_id)
                    & (Message.role == 'assistant') & (Message.channel == 'execution')).order_by(Message.position.desc()).first())
            else:
                message = Message.get_or_none((Message.id == event.get('messageId')) & (Message.task == task.id))
                if message is None or message.channel not in {'execution','review'} or message.role != 'assistant':
                    return None
                step_key = message.step_key
            workflow = project.workflow_by_id(task.workflow_id)
            definition = workflow['steps'] if workflow else project.steps
            steps = WorkflowDefinition.load(definition).compile().steps
            step = next((s for s in steps if str(s['key']) == step_key), {})
            return step_key, step.get('label') or '未命名阶段', message.id if message else review_id, message.content if message else ''
        return await self._projects.run_db(event['project_id'], read)

    async def _handle(self, event):
        project_id, task_id = event['project_id'], event['task_id']
        name, data = event.get('name'), event.get('value') or {}
        if event['type'] in {'TEXT_MESSAGE_END','RUN_ERROR'} or name == 'workstep.interaction_response':
            for key, scope in list(self._scopes.items()):
                if key[:2] == (project_id, task_id) and (
                    scope['assistant_message_id'] == event.get('messageId') or
                    (event['type'] == 'RUN_ERROR' and scope['step_key'] == event.get('step_key'))):
                    if name == 'workstep.interaction_response':
                        await self._controls.event(scope, event)
                    else:
                        await self._controls.finish(scope)
                        self._scopes.pop(key, None)
            return
        review_id = data.get('review_run_id')
        if name in {'workstep.review_result','workstep.review_status'} and data.get('status') != 'awaiting_review':
            return
        metadata = await self._metadata(event)
        if metadata is None:
            return
        step_key, title, message_id, body = metadata
        config = await self._load()
        enabled = {b['id'] for b in config['bots'] if b['enabled']}
        bindings = {(b['bot_id'],b['group_id']) for b in config['groups']
                    if b['project_id'] == project_id and b['task_id'] == task_id and b['bot_id'] in enabled}
        async def deliver(bot_id, group_id):
            identity = (project_id, task_id, message_id, bot_id, group_id,
                review_id or data.get('interaction_id') or data.get('source_item_id'), 'review' if review_id else name)
            if identity in self._seen:
                return
            recipient = IncomingMessage(bot_id, message_id, 'group', group_id, '', '')
            scope_key = (project_id, task_id, message_id, bot_id, group_id)
            scope = self._scopes.get(scope_key)
            if scope is None:
                scope = await self._controls.begin(recipient, project_id, task_id=task_id,
                    assistant_message_id=message_id, step_key=step_key, turn_id=task_id,
                    broadcast=True, stop_button=False)
            if review_id:
                await self._controls.review(scope, review_id, title, body or '步骤执行完成，请审核。')
                # Manual review decisions remain valid after the LLM stops,
                # and across daemon restarts; their database state is authority.
                await self._controls.finish(scope)
            else:
                self._scopes[scope_key] = scope
                await self._controls.event(scope, event)
            self._seen.append(identity)
        await asyncio.gather(*(deliver(*b) for b in bindings))
