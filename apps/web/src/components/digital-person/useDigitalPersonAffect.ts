import {useEffect,useRef,useState} from 'react'
import {digitalAffectApi,type DigitalAffectState} from '../../api/digitalPerson'

/** One scoped request at a time; refresh on terminal turn, visibility and heartbeat interval. */
export function useDigitalPersonAffect(projectId?:string,sessionId?:string,refreshKey='',personId=''){
 const pending=useRef(false),again=useRef(false),reload=useRef<()=>void>(()=>{})
 const [state,setState]=useState<DigitalAffectState|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0)
 useEffect(()=>{
  let alive=true
  setState(null);setError('')
  const load=async()=>{
   if(!alive||document.hidden)return
   if(pending.current){again.current=true;return}
   pending.current=true
   try{const data=await digitalAffectApi.read(sessionId?{project_id:projectId,session_id:sessionId}:{person_id:personId});if(alive){setState(data.state??null);setError('')}}
   catch{if(alive)setError('digitalPerson.affectUnavailable')}
   finally{pending.current=false;if(again.current){again.current=false;reload.current()}}
  }
  reload.current=()=>{void load()}
  void load()
  const tick=()=>{void load()}
  const timer=window.setInterval(tick,30000)
  window.addEventListener('workstep:digital-person-activity-changed',tick)
  document.addEventListener('visibilitychange',tick)
  return()=>{alive=false;window.clearInterval(timer);window.removeEventListener('workstep:digital-person-activity-changed',tick);document.removeEventListener('visibilitychange',tick)}
 },[projectId,sessionId,refreshKey,personId,retry])
 return {state,error,retry:()=>setRetry(n=>n+1)}
}
