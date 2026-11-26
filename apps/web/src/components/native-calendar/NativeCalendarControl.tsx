import {useEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import ConfirmDialog from '../ConfirmDialog'
import Button from '../Button'
import Spinner from '../Spinner'
import {useI18n,localizeErrorDisplay} from '../../i18n'
import {nativeCalendarApi,type CalendarIdentity} from '../../api/nativeCalendar'
import {calendarHost,hasCalendarHost} from '../../utils/calendarHost'
import {useNativeCalendarStore,NATIVE_CALENDAR_OPEN} from '../../stores/nativeCalendarStore'
import {gatewayResourceUrl,gatewayWorkspacePath} from '../../utils/gatewayWorkspacePath'
import {CALENDAR_CHANGED} from '../../api/digitalCalendar'
import './NativeCalendarControl.css'
import DigitalPersonCalendar from '../digital-person/DigitalPersonCalendar'

/** Application-level execution, independent of the currently displayed page. */
export default function NativeCalendarControl(){
 const {t,locale}=useI18n(),state=useNativeCalendarStore(),[busy,setBusy]=useState(false),[permission,setPermission]=useState('not_determined'),[target,setTarget]=useState(''),[deviceId,setDeviceId]=useState('')
 const client=useRef<{identity:CalendarIdentity;host:ReturnType<typeof calendarHost>}|null>(null)
 const [calendar,setCalendar]=useState<{projectId:string;canEdit:boolean}|null>(null),[checking,setChecking]=useState(false)
 const drainRef=useRef<()=>Promise<void>>(async()=>{}),connectRef=useRef<()=>Promise<void>>(async()=>{})
 const workspace=gatewayWorkspacePath()
 useEffect(()=>{
  let disposed=false,socket:WebSocket|undefined,retry:ReturnType<typeof setTimeout>|undefined,running=false,again=false
  const setError=(error:unknown)=>{if(!disposed)useNativeCalendarStore.setState({error:error instanceof Error?error.message:String(error)})}
  const performRegister=async()=>{
   await useNativeCalendarStore.getState().refresh()
   const data={owner:useNativeCalendarStore.getState().owner}
   if(disposed)return
   const namespace=window.location.origin+gatewayWorkspacePath()+':'+data.owner,host=calendarHost(namespace)
   const status=await host.status()
   setPermission(status.permission)
   if(status.permission==='unsupported')return
   const identity=await host.identity()
   await nativeCalendarApi.register(identity,status)
   if(disposed)return
   client.current={identity,host};setDeviceId(identity.device_id);await useNativeCalendarStore.getState().refresh()
   useNativeCalendarStore.setState({localDevice:{namespace,device_id:identity.device_id,platform:identity.platform,permission:status.permission}})
   useNativeCalendarStore.getState().preferDevice(identity.device_id)
   return {identity,host,owner:data.owner}
  }
  let registration:ReturnType<typeof performRegister>|undefined
  const register=()=>registration??(registration=performRegister().finally(()=>{registration=undefined}))
  const drain=async()=>{
   if(running){again=true;return}
   if(disposed||document.hidden||!client.current)return
   running=true
   try{
    const {identity,host}=client.current
    const waiting=await nativeCalendarApi.pending(identity)
    for(const pending of waiting.items){
     if(disposed||document.hidden)break
     let operation=await nativeCalendarApi.claim(identity,pending.id)
     useNativeCalendarStore.getState().observe(operation)
     if(['needs_permission','needs_calendar','needs_device'].includes(operation.status))break
     for(const item of operation.items){
      if(disposed||document.hidden||operation.cancel_requested)break
      if(!['queued','unknown'].includes(item.status))continue
      let receipt
      try{receipt=await host.execute(operation,item)}catch{receipt={item_id:item.id,status:'unknown' as const,error_code:'verification_unknown'}}
      const progress=await nativeCalendarApi.receipt(identity,operation.id,operation.token!,receipt)
      operation={...operation,status:progress.status,cancel_requested:progress.cancel_requested,
       items:operation.items.map(row=>row.id===progress.item.id?{...row,...progress.item}:row)}
      if(!disposed)useNativeCalendarStore.getState().observe(operation)
      window.dispatchEvent(new Event(CALENDAR_CHANGED))
      if(receipt.error_code==='permission_required'){
       setPermission('denied');await nativeCalendarApi.register(identity,await host.status());break
      }
     }
    }
   }catch(error){
    const operation=useNativeCalendarStore.getState().operation
    if(operation&&!['succeeded','partial','failed','cancelled'].includes(operation.status))useNativeCalendarStore.getState().observe({...operation,status:'unknown'})
    setError(error)
   }finally{running=false;if(again){again=false;if(!disposed)queueMicrotask(()=>{void drain()})}}
  }
  const socketActive=()=>Boolean(socket&&socket.readyState<=WebSocket.OPEN)
  const connect=async()=>{
   if(disposed||!hasCalendarHost()||document.hidden||socketActive())return
   try{
    const registration=await register();if(!registration||disposed||socketActive())return
    const url=gatewayResourceUrl(`${window.location.protocol==='https:'?'wss:':'ws:'}//${window.location.host}/ws?calendar_device=1`)
    socket=new WebSocket(url)
    socket.onopen=()=>socket?.send(JSON.stringify({...registration.identity,owner:registration.owner}))
    socket.onmessage=event=>{try{const data=JSON.parse(event.data);if(data.type==='ping')socket?.send(JSON.stringify({type:'ping'}));if(['ready','operation_available'].includes(data.type))void drain();if(data.type==='replaced'){disposed=true;socket?.close()}}catch{/* Malformed control messages do not execute anything. */}}
    socket.onclose=()=>{if(!disposed)retry=setTimeout(()=>{void connect()},10000)}
   }catch(error){setError(error);if(!disposed)retry=setTimeout(()=>{void connect()},10000)}
  }
  connectRef.current=async()=>{socket?.close();socket=undefined;await connect()}
  drainRef.current=drain
  const open=(event:Event)=>{
   setCalendar((event as CustomEvent).detail??null)
   const selected=useNativeCalendarStore.getState().defaultTarget;setTarget(selected==='internal'?'':selected)
   useNativeCalendarStore.setState({open:true,operation:null,error:''})
   if(hasCalendarHost()){
    setChecking(true)
    void register().catch(setError).finally(()=>{if(!disposed)setChecking(false)})
   }else void useNativeCalendarStore.getState().refresh().catch(setError)
  }
  const resume=()=>{if(!document.hidden){if(hasCalendarHost())void register().then(()=>{void connect();void drain()}).catch(setError);const operation=useNativeCalendarStore.getState().operation;if(operation)void nativeCalendarApi.operation(operation.id).then(operation=>{if(!disposed)useNativeCalendarStore.setState({operation,...(['succeeded','cancelled'].includes(operation.status)?{open:false}:{})})}).catch(setError)}}
  window.addEventListener(NATIVE_CALENDAR_OPEN,open);document.addEventListener('visibilitychange',resume);window.addEventListener('focus',resume)
  if(hasCalendarHost())void connect()
  return()=>{disposed=true;clearTimeout(retry);socket?.close();client.current=null;window.removeEventListener(NATIVE_CALENDAR_OPEN,open);document.removeEventListener('visibilitychange',resume);window.removeEventListener('focus',resume)}
 },[workspace])
 const run=async(action:()=>Promise<void>)=>{setBusy(true);useNativeCalendarStore.setState({error:''});try{await action()}catch(error){useNativeCalendarStore.setState({error:error instanceof Error?error.message:String(error)})}finally{setBusy(false)}}
 const authorize=()=>run(async()=>{
  if(!client.current)await connectRef.current()
  if(!client.current)throw new Error(t('nativeCalendar.unavailable'))
  const {host,identity}=client.current
  const status=await host.permission()
  await nativeCalendarApi.register(identity,status);await state.refresh()
  useNativeCalendarStore.setState(current=>({localDevice:current.localDevice?{...current.localDevice,permission:status.permission}:null}))
  useNativeCalendarStore.getState().preferDevice(identity.device_id);setPermission(status.permission)
  if(status.permission==='granted'){
   if(state.operation?.items.some(item=>item.error_code==='permission_required'))await nativeCalendarApi.resume(state.operation.id)
   await drainRef.current()
  }
 })
 const choose=()=>run(async()=>{
  state.select(target)
  if(state.operation?.status==='needs_calendar'&&client.current){
   await nativeCalendarApi.select(client.current.identity,state.operation.id,target)
   await drainRef.current()
  }
 })
 const operation=state.operation
 const complete=operation&&['succeeded','partial','failed','cancelled'].includes(operation.status)
 const thisDevice=state.targets.filter(row=>row.device_id===deviceId&&row.available!==false)
 const dateLabel=(value:string,zone:string)=>new Date(value).toLocaleString(locale,{timeZone:zone,year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})
 const showCalendar=Boolean(calendar&&!operation&&!checking&&(!state.syncEnabled||permission==='granted'||!hasCalendarHost()||permission==='unsupported'))
 return createPortal(<ConfirmDialog open={state.open} title={t(calendar&&!operation?'digitalCalendar.title':'nativeCalendar.title')} className={showCalendar?'digital-calendar-window':undefined} showClose={showCalendar} hideFooter width={480} zIndex={calendar&&!operation?1300:2000} onConfirm={()=>{}} onCancel={()=>{if(!busy)useNativeCalendarStore.setState({open:false})}}>
  <div className="native-calendar-control">
   {checking?<Spinner/>:showCalendar?<DigitalPersonCalendar presentation="panel" active={state.open} projectId={calendar!.projectId} canEdit={calendar!.canEdit}/>:<>
   {operation&&<div role="status" className="native-calendar-progress">
    {['executing','queued'].includes(operation.status)&&<Spinner size={16}/>}
    <span>{t(`nativeCalendar.status_${operation.status}` as never)} · {operation.items.filter(row=>row.status==='succeeded').length}/{operation.items.length}</span>
   </div>}
   {operation&&operation.items.length>0&&<p>{dateLabel(operation.items[0].draft.starts_at,operation.items[0].draft.timezone_name)}{operation.items.length>1&&` – ${dateLabel(operation.items.at(-1)!.draft.starts_at,operation.items.at(-1)!.draft.timezone_name)}`} · {operation.items[0].draft.timezone_name}</p>}
   {operation?.action==='delete'&&!complete&&<p>{t('nativeCalendar.deletePending')}</p>}
   {operation?.items.some(row=>['failed','unknown'].includes(row.status))&&<p className="native-calendar-error">{t('nativeCalendar.partialWarning')}</p>}
   {operation&&<ul className="native-calendar-failures">{operation.items.filter(row=>['failed','unknown'].includes(row.status)).map(item=><li key={item.id}><time>{dateLabel(item.draft.starts_at,item.draft.timezone_name)}</time><span>{t(`nativeCalendar.error_${['permission_required','conflict','provider_error'].includes(item.error_code??'')?item.error_code:'unknown'}` as never)}</span></li>)}</ul>}
   {hasCalendarHost()&&permission!=='granted'&&permission!=='unsupported'&&<>
    <p>{t('nativeCalendar.permissionIntro')}</p>
    <div className="native-calendar-actions"><Button variant="primary" loading={busy} onClick={()=>void authorize()}>{t(permission==='denied'||permission==='restricted'?'nativeCalendar.settings':'nativeCalendar.authorize')}</Button></div>
   </>}
   {permission==='granted'&&thisDevice.length>0&&((!operation&&state.syncEnabled)||operation?.status==='needs_calendar')&&<>
    <label htmlFor="native-calendar-target">{t('nativeCalendar.calendar')}</label>
    <select id="native-calendar-target" value={target} onChange={event=>setTarget(event.target.value)}><option value="">{t('nativeCalendar.select')}</option>{thisDevice.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select>
    <Button variant="primary" loading={busy} disabled={!target} onClick={()=>void choose()}>{t('nativeCalendar.useCalendar')}</Button>
   </>}
   {permission==='granted'&&thisDevice.length===0&&<p>{t('nativeCalendar.noCalendar')}</p>}
   {(!hasCalendarHost()||permission==='unsupported')&&<p>{t('nativeCalendar.unavailable')}</p>}
   </>}
   {state.error&&<p className="native-calendar-error" role="alert">{localizeErrorDisplay(state.error)}</p>}
   {!showCalendar&&<div className="native-calendar-actions">
    {operation&&['needs_device','failed','partial','unknown'].includes(operation.status)&&<Button loading={busy} onClick={()=>void run(async()=>{state.observe(await nativeCalendarApi.resume(operation.id));await drainRef.current()})}>{t('nativeCalendar.resume')}</Button>}
    {operation&&!complete&&<Button disabled={busy} onClick={()=>void run(async()=>{state.observe(await nativeCalendarApi.cancel(operation.id))})}>{t('nativeCalendar.cancelOperation')}</Button>}
    <Button onClick={()=>useNativeCalendarStore.setState({open:false})} disabled={busy}>{t('common.close')}</Button>
   </div>}
  </div>
 </ConfirmDialog>,document.body)
}
