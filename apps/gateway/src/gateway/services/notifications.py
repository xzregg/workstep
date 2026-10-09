"""Shared, bounded collection of existing daemon completion summaries."""
import asyncio
import hashlib
import json
import logging
import re
import time
from dataclasses import replace
from urllib.parse import urlsplit, urlencode

from sqlalchemy import select, or_, and_, func, delete
from gateway.contracts import GatewayCall
from gateway.models import (CompletionNotification as Notice, NotificationReadCursor, Device,
    User, UserGroup, GroupMembership, PlatformProject, ProjectAccessGrant)
from .device_grants import assigned_device_ids
from .control_connection import binding_active

logger = logging.getLogger(__name__)
RETENTION = 7 * 86400


def visible_to(user_id):
    groups = select(GroupMembership.group_id).join(UserGroup, UserGroup.id == GroupMembership.group_id).where(
        GroupMembership.user_id == user_id, GroupMembership.revoked_at.is_(None), UserGroup.status == 'active')
    granted = select(PlatformProject.host_project_id).join(ProjectAccessGrant,
        ProjectAccessGrant.project_id == PlatformProject.id).where(
        PlatformProject.device_id == Notice.device_id, PlatformProject.status == 'active',
        PlatformProject.access_mode == 'remote_published', ProjectAccessGrant.revoked_at.is_(None),
        or_(and_(ProjectAccessGrant.subject_type == 'user',ProjectAccessGrant.subject_id == user_id),
            and_(ProjectAccessGrant.subject_type == 'group',ProjectAccessGrant.subject_id.in_(groups))))
    return and_(Notice.device_id.in_(select(Device.id).where(Device.status == 'active')),
        or_(Notice.device_id.in_(assigned_device_ids(user_id)), Notice.host_project_id.in_(granted)))


def summary(event, project_id):
    if not isinstance(event, dict) or event.get('project_id') != project_id:
        return None
    kind, status = event.get('type'), event.get('status')
    step = kind in ('RUN_FINISHED','RUN_ERROR')
    if step:
        if (kind,status) not in (('RUN_FINISHED','passed'),('RUN_ERROR','failed')) or not event.get('step_key') or not event.get('task_id'):
            return None
    elif kind != 'TEXT_MESSAGE_END' or status not in ('succeeded','failed','error') or not event.get('messageId') or not (event.get('session_id') or event.get('task_id')):
        return None
    names = ('type','status','channel','task_id','session_id','messageId','step_key','sequence','scope_name')
    data = {key:event.get(key) for key in names}
    if any(value is not None and (not isinstance(value,(str,int)) or len(str(value))>256) for value in data.values()):
        return None
    if data['channel'] == 'session_chat' and data['session_id']:
        data['task_id'] = None
    return data


class NotificationService:
    def __init__(self, database, controls, settings, *, interval=15):
        self.database, self.controls, self.settings = database, controls, settings
        self.interval = interval
        self.listeners: set[asyncio.Queue] = set()
        self.connections: dict[str,int] = {}
        self.slots = asyncio.Semaphore(8)
        self.lock = asyncio.Lock()
        self.catalog = {}
        self.since = {}
        self.offset = {}
        self.names = {}
        self.task = None
        self.last_cleanup = 0

    def wake(self):
        for queue in self.listeners:
            if queue.empty(): queue.put_nowait(True)

    async def record(self, device_id, project_id, project_name, events):
        rows = {}
        now = time.time()
        for event in events[:1000]:
            data = summary(event,project_id)
            stamp = event.get('recorded_at') if isinstance(event,dict) else None
            if data is None or type(stamp) not in (int,float) or not now-RETENTION <= stamp <= now+60:
                continue
            identity = [device_id,project_id,data['task_id'] if data['step_key'] else data['session_id'] or data['task_id'],
                data['step_key'] if data['step_key'] else data['messageId'],data['sequence'] if data['step_key'] else None]
            key = hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest()
            rows[key] = dict(event_key=key,device_id=device_id,host_project_id=project_id,
                project_name=project_name[:256],payload_json=json.dumps(data),occurred_at=stamp)
        if not rows: return
        async with self.lock:
            async with self.database.session() as session:
                async with session.begin():
                    existing = set((await session.scalars(select(Notice.event_key).where(Notice.event_key.in_(rows)))).all())
                    session.add_all(Notice(**row) for key,row in rows.items() if key not in existing)
        if len(existing)<len(rows): self.wake()

    async def list(self,user_id,*,after=0,before=None,limit=100):
        async with self.database.session() as session:
            cursor = await session.get(NotificationReadCursor,user_id)
            read = cursor.through if cursor else 0
            current = await session.scalar(select(func.max(Notice.sequence))) or 0
            conditions = [visible_to(user_id),Notice.occurred_at>=time.time()-RETENTION,Notice.sequence>after]
            unread = await session.scalar(select(func.count()).select_from(Notice).where(
                visible_to(user_id),Notice.occurred_at>=time.time()-RETENTION,Notice.sequence>read))
            if before is not None: conditions.append(Notice.sequence<before)
            rows = (await session.execute(select(Notice,Device.name).join(Device,Device.id==Notice.device_id)
                .where(*conditions).order_by(Notice.sequence.desc()).limit(limit+1))).all()
            events = [dict(json.loads(row.payload_json),sequence=row.sequence,id=row.event_key,device_id=row.device_id,device_name=name,
                host_project_id=row.host_project_id,project_name=row.project_name,occurred_at=row.occurred_at,
                read=row.sequence<=read,source_sequence=json.loads(row.payload_json).get('sequence')) for row,name in rows[:limit]]
        return dict(events=events,unread=unread,cursor=current,more=len(rows)>limit)

    async def mark_read(self,user_id,through):
        async with self.lock:
            async with self.database.session() as session:
                async with session.begin():
                    current = await session.scalar(select(func.max(Notice.sequence))) or 0
                    value = min(through,current)
                    row = await session.get(NotificationReadCursor,user_id)
                    if row: row.through=max(row.through,value)
                    else: session.add(NotificationReadCursor(user_id=user_id,through=value))
        self.wake()

    async def collect_device(self,device_id,user_id):
        async with self.slots:
            await asyncio.wait_for(self._collect_device(device_id,user_id),timeout=30)

    async def _collect_device(self,device_id,user_id):
        call = GatewayCall(database=self.database,settings=self.settings,control_connections=self.controls)
        if not await binding_active(call,device_id,user_id): return
        async with self.database.session() as session:
            user = await session.get(User,user_id)
        cached = self.catalog.get(device_id)
        if not cached or cached[0]<time.monotonic()-60:
            projects = await self.controls.request_project_catalog(device_id)
            self.catalog[device_id]=(time.monotonic(),projects)
        else: projects=cached[1]
        connection = await self.controls.request_data(device_id)
        offset=self.offset.get(device_id,0)%max(1,len(projects))
        batch=(projects+projects)[offset:offset+min(20,len(projects))]
        for project in batch:
            id=project['id']
            query=urlencode(dict(project_id=id,since=max(0,self.since.get((device_id,id),0)-5)))
            async def empty():
                if False: yield b''
            request=replace(call,target=urlsplit('http://localhost/api/completion-notifications/recent?'+query),payload=empty)
            response=await connection.proxy_http(request,user_id=user_id,username=user.username,
                display_name=user.display_name,project_id=id,access_level='read')
            content=bytearray()
            async for chunk in response.chunks:
                content.extend(chunk)
                if len(content)>1024*1024: raise ValueError('Notification response too large')
            if response.status!=200: continue
            events=json.loads(content).get('events',[])
            if not isinstance(events,list): raise ValueError('Invalid notification response')
            for event in events[:20]:
                data=summary(event,id)
                if not data: continue
                scope=data['task_id'] or data['session_id']
                key=(device_id,id,scope)
                if key not in self.names and isinstance(scope,str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}',scope):
                    try:
                        path=('/api/task/' if data['task_id'] else '/api/chat-sessions/')+scope
                        detail=await connection.proxy_http(replace(request,target=urlsplit('http://localhost'+path+'?'+urlencode(dict(project_id=id,limit=1)))),
                            user_id=user_id,username=user.username,project_id=id,access_level='read')
                        text=bytearray()
                        async for chunk in detail.chunks:
                            text.extend(chunk)
                            if len(text)>1024*1024: raise ValueError('Scope too large')
                        payload=json.loads(text) if detail.status==200 else {}
                        title=payload.get('title') or payload.get('name') or ''
                        self.names[key]=str(title)[:256]
                        if len(self.names)>2048: self.names.pop(next(iter(self.names)))
                    except (ValueError,ConnectionError,asyncio.TimeoutError): pass
                event['scope_name']=self.names.get(key,'')
            await self.record(device_id,id,project['name'],events)
            stamps=[event.get('recorded_at',0) for event in events if isinstance(event,dict)
                    and type(event.get('recorded_at')) in (int,float)]
            if stamps: self.since[(device_id,id)]=max(self.since.get((device_id,id),0),max(stamps))
        self.offset[device_id]=offset+len(batch)

    async def run(self):
        async def collect(device_id,user_id):
            try:
                await self.collect_device(device_id,user_id)
            except Exception as error:
                logger.debug('Notification collection unavailable: %s',type(error).__name__)
        while True:
            await asyncio.gather(*(collect(*source) for source in self.controls.notification_sources()))
            if time.time()-self.last_cleanup>3600:
                try:
                    async with self.lock:
                        async with self.database.session() as session:
                            async with session.begin():
                                await session.execute(delete(Notice).where(Notice.occurred_at<time.time()-RETENTION))
                    self.last_cleanup=time.time()
                except Exception as error:
                    logger.warning('Notification retention cleanup failed: %s',type(error).__name__)
            await asyncio.sleep(self.interval)

    async def close(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task,return_exceptions=True)
