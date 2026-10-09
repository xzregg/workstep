import { DeviceTabs } from './DeviceTabs'
import { useEffect, useState } from 'react'
import type { WorkspaceDevice } from './MyWorkstepWorkspace'
import type { Project } from './ProjectCard'
import { openRemoteAccess } from './openRemoteAccess'

export function DirectWorkstepWorkspace({ devices, projects }: { devices: WorkspaceDevice[]; projects: Project[] }) {
  const [selected, setSelected] = useState(() => {
    let previous = ''
    try { previous = sessionStorage.getItem('workstep-device') ?? '' } catch { /* Storage may be unavailable. */ }
    return devices.find(item => item.id === previous)?.id ?? devices.find(item => item.online)?.id ?? devices[0].id
  })
  const device = devices.find(item => item.id === selected) ?? devices[0]
  const available = projects.filter(item => item.device_id === device.id)
  const [refresh, setRefresh] = useState(0)
  const [projectId, setProjectId] = useState('')
  const project = available.find(item => item.id === projectId) ?? available[0]
  const key = device.id + ':' + refresh + ':' + (device.project_only ? project?.id ?? '' : 'all')
  function choose(id: string) {
    setSelected(id); setProjectId('')
    try { sessionStorage.setItem('workstep-device', id) } catch { /* Optional preference. */ }
  }
  return <div className="gateway-direct-workspace">
    <DeviceTabs devices={devices} currentDeviceId={device.id} onSelect={choose}
      onRefresh={()=>setRefresh(value=>value+1)}/>
    {device.project_only && <div className="gateway-direct-projects"><span>仅可访问已授权项目</span>
      <div role="tablist" aria-label="切换授权项目">{available.map(item => <button type="button" role="tab" key={item.id}
        aria-selected={item.id === project?.id} onClick={() => {setProjectId(item.id)}}>{item.name}</button>)}</div>
    </div>}
    {device.online ? <DirectConnection key={key} device={device} project={device.project_only ? project : undefined}/> :
      <div className="gateway-offline-workspace" role="status"><span aria-hidden="true">▣</span><h3>{device.name || device.id} 当前离线</h3><p>正在等待设备上线，上线后会自动连接。<br/>也可以切换到其他在线设备。</p></div>}
  </div>
}

function DirectConnection({device,project}:{device:WorkspaceDevice;project?:Project}) {
 const [attempt,setAttempt]=useState(0)
 const [error,setError]=useState('')
 const [permanent,setPermanent]=useState(false)
 const [retrying,setRetrying]=useState(false)
 useEffect(()=>{
  const controller=new AbortController()
  let timer:ReturnType<typeof setTimeout>
  setError('');setPermanent(false);setRetrying(false)
  async function connect(){
   try {
    const path=`/api/${project?'projects':'devices'}/${encodeURIComponent(project?.id ?? device.id)}/access`
    const response=await fetch(path,{credentials:'same-origin',signal:controller.signal})
    if(!response.ok){
     const stop=[401,403,404,422].includes(response.status)
     if(!controller.signal.aborted){
      setPermanent(stop);setError(stop?'访问授权已失效，请重新登录或联系管理员。':'网关或设备暂时断开，正在自动重连…');setRetrying(!stop)
      if(!stop)timer=setTimeout(()=>setAttempt(value=>value+1),Math.min(3000*2**attempt,15000))
     }
     return
    }
    const access=await response.json()
    if(!controller.signal.aborted)openRemoteAccess(access)
   }catch(reason){
    if(controller.signal.aborted)return
    setError(reason instanceof Error?reason.message:'连接失败。');setRetrying(true)
    timer=setTimeout(()=>setAttempt(value=>value+1),Math.min(3000*2**attempt,15000))
   }
  }
  void connect()
  return()=>{controller.abort();clearTimeout(timer)}
 },[device.id,project?.id,attempt])
 return <div className="gateway-direct-state" role={permanent?'alert':'status'}>
  {!permanent && <span className="gateway-spinner"/>}
  <span>{error || `正在进入 ${device.name} 的 WorkStep 工作台…`}</span>
  {error && <button type="button" onClick={()=>setAttempt(value=>value+1)}>{retrying?'立即重试':'重新连接'}</button>}
 </div>
}
