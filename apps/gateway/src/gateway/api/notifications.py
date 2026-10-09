from fastapi import APIRouter, Request, WebSocket, Query
from gateway.api.adapters import invoke
from gateway.services import notifications_api as service
from gateway.services.notifications_api import ReadInput

router=APIRouter(prefix='/api/notifications')

@router.get('')
async def recent(request:Request,after:int=Query(0,ge=0),before:int|None=Query(None,ge=1),limit:int=Query(100,ge=1,le=100)):
    return await invoke(service.recent,request=request,after=after,before=before,limit=limit)

@router.post('/read')
async def mark_read(request:Request,body:ReadInput):
    return await invoke(service.mark_read,request=request,body=body)

@router.websocket('/ws')
async def feed(ws:WebSocket):
    await invoke(service.feed,ws=ws)

@router.get('/{sequence}/access')
async def open_notification(request:Request,sequence:int):
    return await invoke(service.open_notification,request=request,sequence=sequence)


compat_router=APIRouter()

@compat_router.websocket('/ws/notifications')
async def notification_feed(ws:WebSocket):
    await invoke(service.feed,ws=ws)

@compat_router.websocket('/ws')
async def legacy_feed(ws:WebSocket):
    await invoke(service.legacy_feed,ws=ws)

@compat_router.get('/api/completion-notifications/recent')
async def legacy_recent(request:Request,project_id:str=Query(min_length=1,max_length=256),since:float=Query(0,ge=0)):
    return await invoke(service.legacy_recent,request=request,project_id=project_id,since=since)

@compat_router.get('/api/completion-notifications/access')
async def legacy_access(request:Request,project_id:str=Query(min_length=1,max_length=256),task_id:str|None=None,session_id:str|None=None):
    return await invoke(service.legacy_access,request=request,project_id=project_id,task_id=task_id,session_id=session_id)
