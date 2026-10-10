import asyncio
import hmac
from pydantic import BaseModel,Field
from gateway.contracts import SocketClosed
from gateway.services.identity import IdentityService,COOKIE_NAME,csrf_token
from gateway.services.identity_errors import IdentityError
from gateway.services.errors import GatewayError
from sqlalchemy import select,or_,func
import json
import time
from .notifications import RETENTION
from urllib.parse import urlencode, urlsplit
from gateway.models import CompletionNotification,PlatformProject
from .notifications import visible_to
from .device_grants import has_device_access
from .user_devices_api import device_access_for_user
from .project_access_api import project_access


async def actor(call):
    user,_=await IdentityService(call.database).session_user(call.tokens.get(COOKIE_NAME))
    return user

async def recent(call,after=0,before=None,limit=100):
    user=await actor(call)
    return await call.notifications.list(user.id,after=after,before=before,limit=limit)

class ReadInput(BaseModel):
    through:int=Field(ge=0)

async def open_notification(call,sequence):
    user=await actor(call)
    async with call.database.session() as session:
        notice=await session.scalar(select(CompletionNotification).where(
            CompletionNotification.sequence==sequence,visible_to(user.id)))
        if notice is None: raise GatewayError('not_found','Notification unavailable')
        whole=await has_device_access(session,user.id,notice.device_id)
        project=await session.scalar(select(PlatformProject).where(PlatformProject.device_id==notice.device_id,
            PlatformProject.host_project_id==notice.host_project_id))
    access=await device_access_for_user(call,notice.device_id,user.id) if whole else await project_access(call,project.id)
    data=json.loads(notice.payload_json)
    task=data.get('task_id')
    query=urlencode({'project':notice.project_name,'task' if task else 'session':task or data.get('session_id')})
    return dict(access,next=('tasks' if task else 'chat')+'?'+query)

async def mark_read(call,body:ReadInput):
    user=await actor(call)
    if not hmac.compare_digest(call.proofs.get('x-csrf-token',''),csrf_token(call.tokens[COOKIE_NAME])):
        raise GatewayError('forbidden','CSRF token required')
    await call.notifications.mark_read(user.id,body.through)
    return {'ok':True}

async def feed(ws,*,legacy=False):
    call=ws
    queue=asyncio.Queue(maxsize=1)
    tasks=[]
    registered=False
    try:
        user=await actor(call)
        origin=call.proofs.get('origin')
        expected=('https' if call.target.scheme=='wss' else 'http')+'://'+call.target.netloc
        public = urlsplit(call.settings.public_origin or '')
        # TLS may terminate at the proxy; accept only the configured public host.
        if public.netloc == call.target.netloc:
            expected = public.scheme + '://' + public.netloc
        if origin!=expected and not (legacy and origin is None):
            await call.close(code=4403); return
        if call.notifications.connections.get(user.id,0)>=5 or len(call.notifications.listeners)>=512:
            await call.close(code=1013); return
        call.notifications.connections[user.id]=call.notifications.connections.get(user.id,0)+1
        registered=True
        await call.accept()
        call.notifications.listeners.add(queue)
        cursor=(await call.notifications.list(user.id))['cursor'] if legacy else 0
        subscription=None
        async def send_updates():
            while True:
                await actor(call)
                nonlocal cursor
                if legacy:
                    if subscription:
                        rows=await legacy_rows(call,user.id,subscription.project_id,after=cursor,
                            task_ids=subscription.task_ids,session_ids=subscription.session_ids)
                        for row in rows:
                            await asyncio.wait_for(call.send_json(legacy_event(row,subscription.project_id)),timeout=5)
                            cursor=row.sequence
                else:
                    await asyncio.wait_for(call.send_json({'type':'notifications',**await call.notifications.list(user.id)}),timeout=5)
                try: await asyncio.wait_for(queue.get(),timeout=10)
                except asyncio.TimeoutError: pass
                await asyncio.sleep(0.5)
        async def receive():
            nonlocal subscription
            while True:
                data=await call.receive_json()
                if isinstance(data,dict) and data.get('type')=='ping': await call.send_json({'type':'pong'})
                if legacy and isinstance(data,dict) and data.get('type')=='subscribe':
                    try:
                        subscription=LegacySubscription.model_validate(data)
                        if not subscription.task_ids and not subscription.session_ids: raise ValueError('Empty subscription')
                    except ValueError:
                        await call.close(code=4400);return
                    if queue.empty():queue.put_nowait(True)
        tasks=[asyncio.create_task(send_updates()),asyncio.create_task(receive())]
        done,_=await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            if not task.cancelled() and task.exception(): raise task.exception()
    except (IdentityError,GatewayError):
        await call.close(code=4401)
    except SocketClosed: pass
    except asyncio.TimeoutError: await call.close(code=1013)
    except asyncio.CancelledError: pass
    finally:
        call.notifications.listeners.discard(queue)
        if registered:
            count=call.notifications.connections.get(user.id,1)-1
            if count: call.notifications.connections[user.id]=count
            else: call.notifications.connections.pop(user.id,None)
        for task in tasks: task.cancel()
        if tasks:
            try: await asyncio.gather(*tasks,return_exceptions=True)
            except asyncio.CancelledError: pass


class LegacySubscription(BaseModel):
    project_id:str=Field(min_length=1,max_length=256)
    task_ids:list[str]=Field(default_factory=list,max_length=256)
    session_ids:list[str]=Field(default_factory=list,max_length=256)


def legacy_scope(project_id):
    if project_id.startswith('gateway/'):
        parts=project_id.split('/')
        if len(parts)!=3 or not all(parts[1:]): raise GatewayError('invalid','Invalid notification project')
        return [CompletionNotification.device_id==parts[1],CompletionNotification.host_project_id==parts[2]]
    return [CompletionNotification.host_project_id==project_id]


async def legacy_rows(call,user_id,project_id,*,after=0,since=0,task_ids=None,session_ids=None,recent=False):
    conditions=[visible_to(user_id),*legacy_scope(project_id),CompletionNotification.sequence>after,
        CompletionNotification.occurred_at>=max(time.time()-RETENTION,since)]
    if task_ids is not None or session_ids is not None:
        conditions.append(or_(func.json_extract(CompletionNotification.payload_json,'$.task_id').in_(task_ids or []),
            func.json_extract(CompletionNotification.payload_json,'$.session_id').in_(session_ids or [])))
    async with call.database.session() as session:
        rows=list((await session.scalars(select(CompletionNotification).where(*conditions).order_by(
            CompletionNotification.sequence.desc() if recent else CompletionNotification.sequence).limit(1000))).all())
    return rows[::-1] if recent else rows


def legacy_event(row,project_id):
    return dict(json.loads(row.payload_json),project_id=project_id,device_id=row.device_id,recorded_at=row.occurred_at)


async def legacy_recent(call,project_id,since=0):
    user=await actor(call)
    rows=await legacy_rows(call,user.id,project_id,since=since,recent=True)
    return {'events':[legacy_event(row,project_id) for row in rows]}


async def legacy_feed(ws):
    call=ws
    if call.settings.is_device_authority(call.proofs.get('host',call.target.netloc)):
        from .remote_access_api import proxy_remote_websocket
        return await proxy_remote_websocket(call,path=call.target.path.lstrip('/'))
    await feed(call,legacy=True)


async def legacy_access(call,project_id,task_id=None,session_id=None):
    user=await actor(call)
    if not task_id and not session_id:
        raise GatewayError('invalid','Notification target required')
    rows=await legacy_rows(call,user.id,project_id,task_ids=[task_id] if task_id else [],
        session_ids=[session_id] if session_id else [],recent=True)
    if rows:
        return await open_notification(call,rows[-1].sequence)
    # Android can receive the device event before the Gateway collector stores it.
    # Its scoped link identifies the source; normal access tickets still enforce
    # current authorization without requiring a retained notification row.
    if not project_id.startswith('gateway/'):
        raise GatewayError('not_found','Notification target unavailable')
    _,device_id,host_project_id=project_id.split('/')  # Validated by legacy_rows.
    async with call.database.session() as session:
        whole=await has_device_access(session,user.id,device_id)
        project=await session.scalar(select(PlatformProject).where(
            PlatformProject.device_id==device_id,PlatformProject.host_project_id==host_project_id))
    if whole:
        access=await device_access_for_user(call,device_id,user.id)
        try:
            catalog=await call.control_connections.request_project_catalog(device_id)
        except (ConnectionError,asyncio.TimeoutError) as exc:
            raise GatewayError('upstream_failed','Source device unavailable') from exc
        source=next((item for item in catalog if item['id']==host_project_id),None)
        if source is None: raise GatewayError('not_found','Source project unavailable')
        name=source['name']
    else:
        if project is None: raise GatewayError('not_found','Source project unavailable')
        access=await project_access(call,project.id)
        name=project.name
    query=urlencode({'project':name,'task' if task_id else 'session':task_id or session_id})
    return dict(access,next=('tasks' if task_id else 'chat')+'?'+query)
