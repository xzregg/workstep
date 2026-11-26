import type {CalendarHostStatus,CalendarIdentity,CalendarOperation,CalendarItem,CalendarReceipt,SystemCalendarPage} from '../api/nativeCalendar'
type Invoke=(action:string,value:Record<string,unknown>)=>Promise<unknown>
declare global {interface Window {WorkStepCalendar?:{postMessage:(message:string)=>void;onmessage:((event:{data:string})=>void)|null}}}
let sequence=0
const pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>()
export function hasCalendarHost(){return Boolean(window.workstepDesktop?.calendar||window.WorkStepCalendar)}
const invoke:Invoke=(action,value)=>{
 if(window.workstepDesktop?.calendar)return window.workstepDesktop.calendar.invoke(action,value)
 const bridge=window.WorkStepCalendar
 if(!bridge)return Promise.reject(new Error('System calendar is unavailable in this client'))
 return new Promise((resolve,reject)=>{
  const id=`calendar-${++sequence}`
  const timer=window.setTimeout(()=>{pending.delete(id);reject(new Error('System calendar result is unknown; reopen the app to reconcile'))},125000)
  pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}})
  bridge.onmessage=event=>{try{const result=JSON.parse(event.data),callback=pending.get(result.id);if(callback){pending.delete(result.id);if(result.error)callback.reject(new Error(result.error));else callback.resolve(result.result)}}catch{/* Ignore malformed native replies. */}}
  try{bridge.postMessage(JSON.stringify({id,action,value}))}catch(error){pending.delete(id);clearTimeout(timer);reject(error)}
 })
}
export function calendarHost(namespace:string){
 return {
  identity:()=>invoke('identity',{namespace}) as Promise<CalendarIdentity>,
  status:()=>invoke('status',{namespace}) as Promise<CalendarHostStatus>,
  permission:async()=>{
   let status=await invoke('status',{namespace}) as CalendarHostStatus
   if(status.permission==='not_determined')status=await invoke('permission',{namespace}) as CalendarHostStatus
   if(status.permission==='denied'||status.permission==='restricted')await invoke('settings',{namespace})
   return status
  },
  settings:()=>invoke('settings',{namespace}),
  events:(since:string,before:string)=>invoke('events',{namespace,since,before}) as Promise<SystemCalendarPage>,
  execute:(operation:CalendarOperation,item:CalendarItem)=>invoke('execute',{namespace,operation:{id:operation.id,action:operation.action,calendar_id:operation.calendar_id},item}) as Promise<CalendarReceipt>,
 }
}
