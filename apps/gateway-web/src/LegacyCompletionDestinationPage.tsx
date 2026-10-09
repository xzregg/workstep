import { useEffect,useState } from 'react'
import { Link,useLocation,useNavigate,useSearchParams } from 'react-router-dom'
import { openRemoteAccess } from './openRemoteAccess'

/** Shipped APKs build root /tasks and /chat links; redeem the scoped source device again. */
export function LegacyCompletionDestinationPage() {
 const [query]=useSearchParams(),location=useLocation(),navigate=useNavigate()
 const [error,setError]=useState(''),[retry,setRetry]=useState(0)
 const project=query.get('project') ?? '',task=query.get('task'),session=query.get('session')
 useEffect(()=>{
  const controller=new AbortController()
  setError('')
  if(!project.startsWith('gateway/') || (!task && !session)){setError('通知目标无效，请从工作台重新打开。');return}
  const parameters=new URLSearchParams({project_id:project,...(task?{task_id:task}:{session_id:session!})})
  void fetch('/api/completion-notifications/access?'+parameters,{credentials:'same-origin',signal:controller.signal}).then(async response=>{
   if(controller.signal.aborted)return
   if(response.status===401){navigate('/auth?next='+encodeURIComponent(location.pathname+location.search),{replace:true});return}
   if(!response.ok)throw Error(response.status===409?'来源设备离线，上线后可重试。':'通知已过期或访问授权已失效。')
   const access=await response.json()
   if(!controller.signal.aborted)openRemoteAccess(access)
  }).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'打开失败，请重试。')})
  return()=>controller.abort()
 },[project,task,session,retry,navigate,location.pathname,location.search])
 return <section className="gateway-admin-page"><h2>打开通知来源</h2>
  {error?<p role="alert">{error}</p>:<p role="status"><span className="gateway-spinner"/> 正在连接来源设备…</p>}
  {error && <button type="button" onClick={()=>setRetry(value=>value+1)}>重试</button>}
  <Link to="/">返回我的 WorkStep</Link>
 </section>
}
