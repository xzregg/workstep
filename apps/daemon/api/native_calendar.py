"""Host-authorized calendar control. Device execution also requires installation credentials."""
import asyncio
import weakref
from fastapi import APIRouter,Header,HTTPException,Body,WebSocket,WebSocketDisconnect
from services.native_calendar import CalendarApplication,OperationDraft,connections

router=APIRouter(prefix='/calendar')
_io_slots=weakref.WeakKeyDictionary()


def application():
    from services.remote_access import get_current_actor
    actor=get_current_actor()
    # Browser display headers are not account authentication. Non-managed host
    # entry points and local CLI share the instance; managed users stay isolated.
    return CalendarApplication(actor.actor_id if actor and actor.source in ('managed','remote') else 'local')


async def run(function,*args):
    loop=asyncio.get_running_loop()
    reference=_io_slots.get(loop)
    slots=reference() if reference else None
    if slots is None:
        slots=asyncio.Semaphore(2)
        _io_slots[loop]=weakref.ref(slots)
    try:
        async with slots:
            worker=asyncio.create_task(asyncio.to_thread(function,*args))
            try:return await asyncio.shield(worker)
            except asyncio.CancelledError:
                # A cancelled HTTP request must not free an I/O slot while its
                # synchronous SQLite unit is still using the worker thread.
                await asyncio.gather(worker,return_exceptions=True)
                raise
    except KeyError as exc:raise HTTPException(404,'Calendar object not found') from exc
    except PermissionError as exc:raise HTTPException(403,str(exc)) from exc
    except (ValueError,TypeError) as exc:raise HTTPException(409,str(exc)) from exc


@router.get('/targets')
async def targets():
    app=await asyncio.to_thread(application)
    rows=await run(app.targets)
    return {'owner':app.owner,'items':[{k:v for k,v in row.items() if k!='calendar_id'}|{'online':row['id']=='internal' or (app.owner,row['device_id']) in connections.clients} for row in rows]}


@router.post('/devices')
async def register(body:dict=Body()):
    app=await asyncio.to_thread(application)
    return await run(app.register,body)


@router.post('/operations')
async def submit(body:OperationDraft):
    app=await asyncio.to_thread(application)
    if bool(body.origin_project_id)!=bool(body.origin_session_id):raise HTTPException(422,'Calendar origin requires both project and session ids')
    if body.origin_session_id:
        from main import project_manager
        from models.chat_session import ChatSession
        try:
            valid=await project_manager.run_db(body.origin_project_id,lambda _:ChatSession.get_or_none(ChatSession.id==body.origin_session_id,ChatSession.archived==False) is not None)
        except (KeyError,ValueError) as exc:
            raise HTTPException(404,'Calendar originating project not found') from exc
        if not valid:raise HTTPException(404,'Calendar originating conversation not found')
    result=await run(app.submit,body.model_dump(mode='json',exclude_none=True))
    if not result['device_id']:
        result=await run(app.execute_internal,result['id'])
        from api.digital_person import runtime
        await runtime().calendar.changed()
    elif (app.owner,result['device_id']) not in connections.clients:
        result=await run(app.wait_device,result['id'])
    connections.notify(app.owner,result['device_id'],result['id'])
    return result


@router.get('/operations/{operation_id}')
async def operation(operation_id:str):
    app=await asyncio.to_thread(application)
    return await run(app.operation,operation_id)


@router.post('/operations/{operation_id}/resume')
async def resume(operation_id:str):
    app=await asyncio.to_thread(application)
    result=await run(app.resume,operation_id)
    connections.notify(app.owner,result['device_id'],operation_id)
    return result


@router.post('/operations/{operation_id}/cancel')
async def cancel(operation_id:str):
    app=await asyncio.to_thread(application)
    result=await run(app.cancel,operation_id)
    connections.notify(app.owner,result['device_id'],operation_id)
    return result


@router.get('/devices/{device_id}/pending')
async def pending(device_id:str,x_calendar_key:str=Header()):
    app=await asyncio.to_thread(application)
    return {'items':await run(app.pending,device_id,x_calendar_key)}


@router.post('/devices/{device_id}/operations/{operation_id}/claim')
async def claim(device_id:str,operation_id:str,x_calendar_key:str=Header()):
    app=await asyncio.to_thread(application)
    return await run(app.claim,operation_id,device_id,x_calendar_key)


@router.post('/devices/{device_id}/operations/{operation_id}/target')
async def select_target(device_id:str,operation_id:str,body:dict=Body(),x_calendar_key:str=Header()):
    app=await asyncio.to_thread(application)
    return await run(app.select_calendar,operation_id,device_id,x_calendar_key,body.get('target_id'))


@router.post('/devices/{device_id}/operations/{operation_id}/receipts')
async def receipt(device_id:str,operation_id:str,body:dict=Body(),x_calendar_key:str=Header()):
    app=await asyncio.to_thread(application)
    result=await run(app.receipt,operation_id,device_id,x_calendar_key,str(body.get('token','')),body.get('receipt',{}))
    from api.digital_person import runtime
    await runtime().calendar.changed()
    if result['action']!='query' and result['status'] in ('succeeded','partial','failed','unknown') and result.get('origin_session_id'):
        succeeded=sum(item['status']=='succeeded' for item in result['items'])
        text=f'日程操作结果：已确认完成 {succeeded}/{len(result["items"])} 项。'
        if result['status']!='succeeded':text+=' 其余操作未完成或结果待核实；未确认删除的系统日程仍可能提醒。'
        await runtime()._deliver_local(result['origin_session_id'],text,
            'native-calendar:'+result['id']+':'+result['status']+':'+str(succeeded),project_id=result['origin_project_id'])
    item=next(row for row in result['items'] if row['id']==body['receipt']['item_id'])
    return {'id':result['id'],'status':result['status'],'cancel_requested':result['cancel_requested'],
            'item':{key:item[key] for key in ('id','status','error_code','verification','revision') if key in item}}


async def device_socket(ws:WebSocket):
    """Dedicated mode on /ws so existing Gateway websocket forwarding is reused."""
    from api.desktop_security import desktop_websocket_allowed
    from api.remote_access_guard import websocket_access_allowed
    from api.project_scope import require_catalog_project
    import main
    if not await desktop_websocket_allowed(ws) or not await asyncio.to_thread(websocket_access_allowed,ws,main.remote_access_service):
        await ws.close(code=4401);return
    try:await asyncio.to_thread(require_catalog_project,'')
    except HTTPException:
        await ws.close(code=4403);return
    app=await asyncio.to_thread(application)
    await ws.accept();key=None;queue=asyncio.Queue(maxsize=32)
    try:
        auth=await asyncio.wait_for(ws.receive_json(),10)
        device_id=auth.get('device_id','');credential=auth.get('key','')
        from services.remote_access import get_current_actor
        actor=get_current_actor()
        owner=str(auth.get('owner',''))
        if actor and actor.source in ('managed','remote') and owner!=actor.actor_id:
            raise HTTPException(403,'Calendar device belongs to another user')
        app=CalendarApplication(owner)
        await run(app.authenticate,device_id,credential)
        key=(app.owner,device_id)
        old=connections.clients.get(key)
        if old and not old.full():old.put_nowait({'type':'replaced'})
        connections.clients[key]=queue
        await ws.send_json({'type':'ready'})
        last_seen=asyncio.get_running_loop().time()
        while True:
            receive=asyncio.create_task(ws.receive_json());notice=asyncio.create_task(queue.get())
            try:
                done,_=await asyncio.wait((receive,notice),timeout=30,return_when=asyncio.FIRST_COMPLETED)
                if notice in done:
                    message=notice.result();await ws.send_json(message)
                    if message['type']=='replaced':break
                if receive in done:
                    last_seen=asyncio.get_running_loop().time()
                    if receive.result().get('type')=='ping':await ws.send_json({'type':'pong'})
                if not done:
                    if asyncio.get_running_loop().time()-last_seen>=60:
                        await ws.close(code=1013);break
                    await ws.send_json({'type':'ping'})
            finally:
                for task in (receive,notice):
                    if not task.done():task.cancel()
                await asyncio.gather(receive,notice,return_exceptions=True)
    except (WebSocketDisconnect,HTTPException,asyncio.TimeoutError,ValueError,KeyError,TypeError):
        if ws.client_state.name=='CONNECTED':await ws.close(code=4403)
    finally:
        if key and connections.clients.get(key) is queue:
            connections.clients.pop(key,None)
            await run(app.disconnected,key[1])
