"""Workflow notification configuration, event capture and durable background delivery."""
import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from urllib.parse import urlencode
from uuid import uuid4

from fastapi import HTTPException
from models import Task, TaskStep, StepRun
from models.notification_hook import NotificationHook, NotificationDelivery
from services.notification_delivery import DeliveryError, notification_payload, send_notification
from schemas.notification_hooks import EVENT_NAMES

logger = logging.getLogger(__name__)


def hook_data(row):
    return {key:getattr(row,key) for key in ('id','workflow_id','name','platform','url','secret','enabled','prefix','include_link','link_base')} | {'events':json.loads(row.events_json)}


def base_addresses():
    from main import remote_access_service, gateway_client
    from services.config import config_store
    settings = remote_access_service.settings()
    gateway = config_store.get('gateway_platform', {})
    from urllib.parse import quote
    return [{'kind':kind,'base_url':base.rstrip('/'),
             'task_base_url': ((base.rstrip('/')+'/workspace/'+quote(gateway_client.device_id,safe='')) if gateway_client.device_id else None) if kind=='gateway' else base.rstrip('/')}
            for kind,base in (('gateway',gateway.get('url','')),('external',settings.get('external_base_url','')),('internal',settings.get('internal_base_url',''))) if base]


def event_kind(event):
    if event.get('channel') not in (None,'execution','review'): return None
    if event.get('type') == 'CUSTOM' and event.get('name') == 'workstep.task_lifecycle':
        kind = event.get('value',{}).get('event')
        return kind if kind in {'started','completed','failed','paused','stopped'} else None
    if not event.get('step_key'): return None
    if event.get('type') == 'CUSTOM' and event.get('name') == 'workstep.interaction_request' and event.get('value',{}).get('interaction_id'):
        return 'waiting'
    if event.get('type') in {'RUN_STARTED','RUN_FINISHED','RUN_ERROR'}:
        status = event.get('status')
    elif event.get('type') == 'CUSTOM' and event.get('name')=='workstep.status':
        status = event.get('value',{}).get('status')
    else: return None
    return {'passed':'step_completed','failed':'step_failed','awaiting_review':'waiting'}.get(status)


class NotificationHookService:
    def __init__(self, manager, bus, *, sender=send_notification):
        self.manager, self.bus, self.sender = manager, bus, sender
        self.queue = None
        self.tasks = []
        self.wake = asyncio.Event()
        self.send_slots = asyncio.Semaphore(4)
        self.scan_slots = asyncio.Semaphore(8)

    def load_configuration(self, project, workflow_id):
        workflow = project.workflow_by_id(workflow_id)
        if workflow is None or workflow.get('deleted'): raise HTTPException(404,'流程不存在')
        return [hook_data(row) for row in NotificationHook.select().where(NotificationHook.workflow_id==workflow_id).order_by(NotificationHook.sort_order)]

    async def configuration(self, project_id, workflow_id):
        hooks = await self.manager.run_db(project_id, lambda p:self.load_configuration(p,workflow_id))
        return {'hooks':hooks,'addresses':await asyncio.to_thread(base_addresses)}

    async def save(self, project_id, workflow_id, drafts):
        def persist(project):
            self.load_configuration(project,workflow_id)
            with project.db.atomic():
                existing = {row.id:row for row in NotificationHook.select().where(NotificationHook.workflow_id==workflow_id)}
                saved = []
                for order,draft in enumerate(drafts):
                    if draft.id and draft.id not in existing: raise HTTPException(422,'钩子不属于当前流程')
                    row = existing.get(draft.id) or NotificationHook(id=str(uuid4()))
                    for key in ('name','platform','url','secret','enabled','prefix','include_link','link_base'):setattr(row,key,getattr(draft,key))
                    row.workflow_id=workflow_id;row.sort_order=order;row.events_json=json.dumps(draft.events)
                    row.save(force_insert=row.id not in existing)
                    saved.append(row.id)
                removed = set(existing)-set(saved)
                if removed:
                    NotificationHook.delete().where(NotificationHook.id.in_(removed)).execute()
                    NotificationDelivery.delete().where(NotificationDelivery.hook_id.in_(removed)).execute()
        await self.manager.run_db(project_id,persist)
        self.wake.set()

    def get_hook(self, project, workflow_id, hook_id):
        self.load_configuration(project,workflow_id)
        row=NotificationHook.get_or_none((NotificationHook.id==hook_id)&(NotificationHook.workflow_id==workflow_id))
        if row is None:raise HTTPException(404,'通知钩子不存在')
        return hook_data(row)

    def snapshot(self, project, workflow, hook, *, event, event_id, task_id, title, step=None, bases=()):
        base=next((b.get('task_base_url',b['base_url']) for b in bases if b['kind']==hook['link_base']),None)
        link=(base+'/tasks?'+urlencode({'project':project.name,'workflow':workflow['id'],'task':task_id})) if base and hook['include_link'] and task_id else None
        return {'event_id':event_id,'event':event,'project':{'id':project.id,'name':project.name},
                'workflow':{'id':workflow['id'],'name':workflow['name']},'task':{'id':task_id,'title':title},
                'step':step,'occurred_at':datetime.now(timezone.utc).isoformat(),'task_url':link}

    def enqueue(self, hook, snapshot):
        now=time.time()
        NotificationDelivery.insert(id=str(uuid4()),hook_id=hook['id'],event_id=snapshot['event_id'],event=snapshot['event'],title=snapshot['task']['title'],snapshot_json=json.dumps(snapshot,ensure_ascii=False),created_at=now,updated_at=now).on_conflict_ignore().execute()

    async def capture(self, event):
        kind=event_kind(event)
        project_id,task_id=event.get('project_id'),event.get('task_id')
        if not kind or not project_id or not task_id:return
        bases=await asyncio.to_thread(base_addresses)
        def persist(project):
            task=Task.get_or_none(Task.id==task_id)
            if task is None or not task.workflow_id:return
            workflow=project.workflow_by_id(task.workflow_id)
            if not workflow or workflow.get('deleted'):return
            step_key=event.get('step_key') if kind in {'step_completed','step_failed','waiting'} else None
            step=None
            if step_key:
                from services.workflow_definition import WorkflowDefinition
                steps=WorkflowDefinition.load(workflow['steps']).compile().steps
                step={'key':step_key,'name':next((s.get('name') or step_key for s in steps if s['key']==step_key),step_key)}
                run=StepRun.select().where((StepRun.step_key==step_key)&(StepRun.run==task.active_workflow_run_id)).order_by(StepRun.attempt.desc()).first() if task.active_workflow_run_id else None
                state=TaskStep.get_or_none((TaskStep.task==task_id)&(TaskStep.step_key==step_key))
                identity=run.id if run else f'{task_id}:{step_key}:{state.started_at if state else ""}:{state.ended_at if state else ""}'
                interaction=event.get('value',{}).get('interaction_id') if event.get('name')=='workstep.interaction_request' else None
                event_id=f'{identity}:{kind}' + (f':{interaction}' if interaction else '')
            else:event_id=event.get('value',{}).get('event_id')
            if not event_id:return
            with project.db.atomic():
                for row in NotificationHook.select().where((NotificationHook.workflow_id==task.workflow_id)&NotificationHook.enabled):
                    hook=hook_data(row)
                    if kind not in hook['events']:continue
                    self.enqueue(hook,self.snapshot(project,workflow,hook,event=kind,event_id=event_id,task_id=task_id,title=task.title,step=step,bases=bases))
        await self.manager.run_db(project_id,persist)
        self.wake.set()

    async def preview(self, project_id, workflow_id, draft, event, title, step):
        bases=await asyncio.to_thread(base_addresses)
        def build(project):
            self.load_configuration(project,workflow_id)
            hook=draft.model_dump()
            snapshot=self.snapshot(project,project.workflow_by_id(workflow_id),hook,event=event,event_id='preview',task_id='preview-task',title=title,step={'name':step} if event in {'step_completed','step_failed','waiting'} else None,bases=bases)
            return {'payload':notification_payload(hook,snapshot),'snapshot':snapshot,'subscribed':event in hook['events']}
        return await self.manager.run_db(project_id,build)

    async def test(self, project_id, workflow_id, hook_id):
        def persist(project):
            hook=self.get_hook(project,workflow_id,hook_id)
            if not hook['enabled']:raise HTTPException(409,'通知钩子已停用')
            event_id=str(uuid4())
            self.enqueue(hook,self.snapshot(project,project.workflow_by_id(workflow_id),hook,event='test',event_id=event_id,task_id=None,title='WorkStep 测试通知'))
            return NotificationDelivery.get((NotificationDelivery.hook_id==hook_id)&(NotificationDelivery.event_id==event_id)).id
        delivery_id=await self.manager.run_db(project_id,persist)
        self.wake.set()
        return delivery_id

    async def records(self, project_id, workflow_id, hook_id, offset=0):
        def load(project):
            self.get_hook(project,workflow_id,hook_id)
            rows=NotificationDelivery.select().where(NotificationDelivery.hook_id==hook_id).order_by(NotificationDelivery.created_at.desc(),NotificationDelivery.id).offset(offset).limit(50)
            return [{key:getattr(row,key) for key in ('id','event','title','status','attempts','created_at','updated_at','result','next_at')} for row in rows]
        return await self.manager.run_db(project_id,load)

    async def retry(self, project_id, workflow_id, hook_id, delivery_id):
        def persist(project):
            hook=self.get_hook(project,workflow_id,hook_id)
            if not hook['enabled']:raise HTTPException(409,'通知钩子已停用')
            count=NotificationDelivery.update(status='pending',cycle_attempts=0,next_at=0,result='',updated_at=time.time()).where((NotificationDelivery.id==delivery_id)&(NotificationDelivery.hook_id==hook_id)&(NotificationDelivery.status=='failed')).execute()
            if not count:raise HTTPException(409,'只能重试当前钩子的失败记录')
        await self.manager.run_db(project_id,persist)
        self.wake.set()

    async def deliver_due(self):
        async def project_work(project):
            async with self.scan_slots:
                def claim(p):
                    now=time.time();jobs=[]
                    with p.db.atomic('IMMEDIATE'):
                        rows=list(NotificationDelivery.select().where((NotificationDelivery.status.in_(['pending','sending']))&(NotificationDelivery.next_at<=now)).order_by(NotificationDelivery.next_at).limit(20))
                        for row in rows:
                            hook=NotificationHook.get_or_none(NotificationHook.id==row.hook_id)
                            workflow=p.workflow_by_id(hook.workflow_id) if hook else None
                            if not hook or not hook.enabled or not workflow or workflow.get('deleted') or (row.event != 'test' and row.event not in json.loads(hook.events_json)):
                                row.status='skipped';row.result='目标停用或已删除';row.updated_at=now;row.save();continue
                            row.status='sending';row.claim_id=str(uuid4());row.attempts+=1;row.cycle_attempts+=1;row.next_at=now+120;row.updated_at=now;row.save()
                            jobs.append((dict(row.__data__),hook_data(hook)))
                    return jobs
                jobs=await self.manager.run_db(project.id,claim)
            await asyncio.gather(*(self.deliver(project.id,row,hook) for row,hook in jobs))
        await asyncio.gather(*(project_work(p) for p in self.manager.iter_projects() if not getattr(p,'is_remote',False)),return_exceptions=False)

    async def deliver(self, project_id, row, hook):
        async with self.send_slots:
            # Renew the claim after waiting for a send slot.
            def renew(_):
                with _.db.atomic('IMMEDIATE'):
                    target=NotificationHook.get_or_none(NotificationHook.id==row['hook_id'])
                    condition=(NotificationDelivery.id==row['id'])&(NotificationDelivery.claim_id==row['claim_id'])&(NotificationDelivery.status=='sending')
                    if not target or not target.enabled or (row['event']!='test' and row['event'] not in json.loads(target.events_json)):
                        NotificationDelivery.update(status='skipped',result='目标停用或取消订阅',updated_at=time.time(),claim_id=None).where(condition).execute()
                        return None
                    if NotificationDelivery.update(next_at=time.time()+60).where(condition).execute():
                        return hook_data(target)
                    return None
            hook=await self.manager.run_db(project_id,renew)
            if not hook:return
            try:
                await asyncio.wait_for(self.sender(hook,notification_payload(hook,json.loads(row['snapshot_json']))),12)
                state,result,next_at='sent','发送成功',0
            except (DeliveryError,asyncio.TimeoutError) as error:
                retryable=isinstance(error,asyncio.TimeoutError) or error.retryable
                retry=retryable and row['cycle_attempts']<4
                state='pending' if retry else 'failed'
                result='连接超时' if isinstance(error,asyncio.TimeoutError) else str(error)
                next_at=time.time()+[30,120,600][row['cycle_attempts']-1] if retry else 0
            except Exception:
                state,result,next_at='failed','发送失败',0
            def finish(_):
                NotificationDelivery.update(status=state,result=result,next_at=next_at,updated_at=time.time(),claim_id=None).where((NotificationDelivery.id==row['id'])&(NotificationDelivery.claim_id==row['claim_id'])).execute()
            await self.manager.run_db(project_id,finish)

    async def start(self):
        self.queue=self.bus.subscribe(lambda event:bool(event_kind(event)))
        self.tasks=[asyncio.create_task(self.consume()),asyncio.create_task(self.poll())]

    async def consume(self):
        while True:
            event=await self.queue.get()
            if event is None:return
            try:await self.capture(event)
            except Exception:logger.warning('Notification event capture failed',exc_info=True)

    async def poll(self):
        while True:
            self.wake.clear()
            try:await self.deliver_due()
            except Exception:logger.warning('Notification outbox scan failed',exc_info=True)
            try:await asyncio.wait_for(self.wake.wait(),2)
            except asyncio.TimeoutError:pass

    async def shutdown(self):
        if self.queue is not None:self.bus.unsubscribe(self.queue)
        for task in self.tasks:task.cancel()
        await asyncio.gather(*self.tasks,return_exceptions=True)
        self.tasks=[]
