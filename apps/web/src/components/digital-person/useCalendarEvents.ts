import {useEffect,useState} from 'react'
import {CALENDAR_CHANGED,digitalCalendarApi,type CalendarEvent} from '../../api/digitalCalendar'
import {useNativeCalendarStore} from '../../stores/nativeCalendarStore'
import {calendarHost} from '../../utils/calendarHost'

/** One request owner for initial load, host events, visibility and recovery polling. */
export function useCalendarEvents(active:boolean,since:string,before:string){
 const [items,setItems]=useState<CalendarEvent[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0)
 const local=useNativeCalendarStore(state=>state.localDevice)
 const syncEnabled=useNativeCalendarStore(state=>state.syncEnabled)
 const [systemNotice,setSystemNotice]=useState('')
 useEffect(()=>{
  if(!active)return
  let disposed=false,pending=false,again=false,againNative=false,lastNativeRead=0
  let systemItems:CalendarEvent[]=[]
  const controller=new AbortController()
  const load=async(refreshNative=true)=>{
   if(disposed||document.hidden)return
   if(pending){again=true;againNative||=refreshNative;return}
   pending=true;setLoading(true);if(!lastNativeRead)setSystemNotice('')
   try{
    const rows:CalendarEvent[]=[]
    let more=true
    while(more&&!disposed){
     const page=await digitalCalendarApi.list(since,before,rows.length,controller.signal)
     const next=page.items??[]
     rows.push(...next);more=Boolean(page.has_more&&next.length)
    }
    if(syncEnabled&&local?.platform==='android'&&local.permission==='granted'&&refreshNative&&Date.now()-lastNativeRead>5000){
     lastNativeRead=Date.now()
     try{
      const page=await calendarHost(local.namespace).events(since,before)
      systemItems=page.items.filter(event=>!event.workstep_owned).map(event=>({
       id:`system:${local.device_id}:${event.system_id}:${event.starts_at}`,revision:'',created_at:'',updated_at:'',reminder_at:event.starts_at,
       content:event.content,starts_at:event.all_day?new Date(event.starts_at.slice(0,10)+'T00:00:00').toISOString():event.starts_at,
       timezone_name:event.timezone_name,reminder_minutes:0,reminder_status:'system',system_readonly:true,system_calendar_name:event.calendar_name,all_day:event.all_day,
      }))
      if(!disposed)setSystemNotice(page.has_more?'nativeCalendar.readLimited':page.items.some(event=>event.content_truncated)?'nativeCalendar.readTruncated':'')
     }catch{if(!disposed)setSystemNotice('nativeCalendar.readFailed')}
    }
    if(!disposed){setItems([...rows,...systemItems].sort((a,b)=>a.starts_at.localeCompare(b.starts_at)));setError('')}
   }catch(reason){if(!disposed)setError(String(reason))}finally{
    pending=false
    if(!disposed){setLoading(false);if(again){const native=againNative;again=false;againNative=false;void load(native)}}
   }
  }
  void load()
  const refresh=()=>{void load()}
  window.addEventListener(CALENDAR_CHANGED,refresh);document.addEventListener('visibilitychange',refresh)
  const timer=window.setInterval(()=>{void load(false)},30000)
  return()=>{disposed=true;controller.abort();window.clearInterval(timer);window.removeEventListener(CALENDAR_CHANGED,refresh);document.removeEventListener('visibilitychange',refresh)}
 },[active,since,before,revision,syncEnabled,local?.namespace,local?.platform,local?.permission,local?.device_id])
 return {items,loading,error,systemNotice,reload:()=>setRevision(value=>value+1)}
}
