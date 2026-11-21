import { localizeGatewayError } from './gatewayErrorText'
import { useEffect,useState } from 'react'
import { Link,useLocation,useNavigate,useSearchParams } from 'react-router-dom'
import { openRemoteAccess } from './openRemoteAccess'

/** Recover scoped Android links and workspace links whose device session expired. */
export function LegacyCompletionDestinationPage() {
 const [query]=useSearchParams(),location=useLocation(),navigate=useNavigate()
 const [error,setError]=useState(''),[retry,setRetry]=useState(0)
 const project=query.get('project') ?? '',task=query.get('task'),session=query.get('session')
 const device=query.get('device'),workflow=query.get('workflow')
 useEffect(()=>{
  const controller=new AbortController()
  setError('')
  if((!project.startsWith('gateway/') && !device) || !project || (!task && !session)){setError('Invalid notification target. Please reopen from the workbench.');return}
  const parameters=new URLSearchParams({project_id:project,...(task?{task_id:task}:{session_id:session!}),
   ...(device?{device_id:device}:{}),...(workflow?{workflow_id:workflow}:{})})
  void fetch('/api/completion-notifications/access?'+parameters,{credentials:'same-origin',signal:controller.signal}).then(async response=>{
   if(controller.signal.aborted)return
   if(response.status===401){navigate('/auth?next='+encodeURIComponent(location.pathname+location.search),{replace:true});return}
   if(!response.ok)throw Error(response.status===409?'Source device is offline; retry after it comes online.':'Notification has expired or access authorization has been invalidated.')
   const access=await response.json()
   if(!controller.signal.aborted)openRemoteAccess(access)
  }).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'Open failed, please try again.')})
  return()=>controller.abort()
 },[project,task,session,device,workflow,retry,navigate,location.pathname,location.search])
 return <section className="gateway-admin-page"><h2>打开通知来源</h2>
  {error?<p role="alert">{localizeGatewayError(error)}</p>:<p role="status"><span className="gateway-spinner"/> 正在连接来源设备…</p>}
  {error && <button type="button" onClick={()=>setRetry(value=>value+1)}>重试</button>}
  <Link className="gateway-action-link" to="/">返回我的 WorkStep</Link>
 </section>
}
