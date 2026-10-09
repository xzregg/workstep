type BridgeMessage = {type:string;id?:string;projectId?:string;url?:string;[key:string]:unknown}
type AndroidWindow = Window & {WorkStepAndroid?:{postMessage:(message:string)=>void}}

/** Preserve the shipped APK's bridge protocol; only opaque IDs and destinations are scoped. */
export function postAndroidCompletion(message:BridgeMessage,deviceId?:string) {
 const bridge=(window as AndroidWindow).WorkStepAndroid
 if(!bridge)return
 if(message.type==='notify' && deviceId && document.visibilityState==='visible' &&
    window.location.pathname.startsWith(`/workspace/${encodeURIComponent(deviceId)}/`)) {
  const query=new URLSearchParams(window.location.search)
  if((message.taskId && query.get('task')===message.taskId) || (message.sessionId && query.get('session')===message.sessionId))return
 }
 const project=message.projectId || message.id?.split(':')[0]
 if(deviceId && project) {
  const scope=`gateway/${deviceId}/${project}`
  message={...message,...(message.projectId?{projectId:scope}:{}),...(message.id?{id:message.id.replace(project+':',scope+':')}: {})}
  if(message.url) {
   const url=new URL(message.url,window.location.href)
   if(message.type==='notify')url.pathname=message.taskId?'/tasks':'/chat'
   url.searchParams.set('project',scope)
   message.url=url.pathname+url.search
  }
 }
 bridge.postMessage(JSON.stringify(message))
}


export function notifyAndroidGatewayCompletion(event:{device_id:string;host_project_id:string;device_name:string;scope_name?:string;
 task_id?:string;session_id?:string;messageId?:string;step_key?:string;source_sequence?:number;status:string}) {
 const project=event.host_project_id,scope=event.session_id || event.task_id
 if(!scope || (!event.step_key && !event.messageId))return
 const id=event.step_key?`${project}:${event.task_id}:step:${event.step_key}:${event.source_sequence ?? event.status}`:`${project}:${scope}:${event.messageId}`
 const target=new URLSearchParams({project,...(event.task_id?{task:event.task_id}:{session:event.session_id!})})
 postAndroidCompletion({type:'notify',id,projectId:project,taskId:event.task_id || null,sessionId:event.session_id || null,
  stepKey:event.step_key,outcome:['succeeded','passed'].includes(event.status)?'succeeded':'failed',
  scopeName:`${event.device_name} · ${event.scope_name || scope}`,url:`/${event.task_id?'tasks':'chat'}?${target}`},event.device_id)
}
