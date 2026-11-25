import {useEffect,useState} from 'react'
import {CALENDAR_CHANGED,digitalCalendarApi,type CalendarEvent} from '../../api/digitalCalendar'

/** One request owner for initial load, host events, visibility and recovery polling. */
export function useCalendarEvents(active:boolean,since:string,before:string){
 const [items,setItems]=useState<CalendarEvent[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0)
 useEffect(()=>{
  if(!active)return
  let disposed=false,pending=false,again=false
  const controller=new AbortController()
  const load=async()=>{
   if(disposed||document.hidden)return
   if(pending){again=true;return}
   pending=true;setLoading(true)
   try{
    const rows:CalendarEvent[]=[]
    let more=true
    while(more&&!disposed){
     const page=await digitalCalendarApi.list(since,before,rows.length,controller.signal)
     const next=page.items??[]
     rows.push(...next);more=Boolean(page.has_more&&next.length)
    }
    if(!disposed){setItems(rows);setError('')}
   }catch(reason){if(!disposed)setError(String(reason))}finally{
    pending=false
    if(!disposed){setLoading(false);if(again){again=false;void load()}}
   }
  }
  void load()
  const refresh=()=>{void load()}
  window.addEventListener(CALENDAR_CHANGED,refresh);document.addEventListener('visibilitychange',refresh)
  const timer=window.setInterval(refresh,30000)
  return()=>{disposed=true;controller.abort();window.clearInterval(timer);window.removeEventListener(CALENDAR_CHANGED,refresh);document.removeEventListener('visibilitychange',refresh)}
 },[active,since,before,revision])
 return {items,loading,error,reload:()=>setRevision(value=>value+1)}
}
