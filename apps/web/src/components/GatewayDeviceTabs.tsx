import { useEffect, useRef, useState } from 'react'
import { ApiError, request } from '../api/transport'
import { useI18n } from '../i18n'
import Spinner from './Spinner'
import { DeviceTabs } from '@workstep/gateway-ui/DeviceTabs'
import { openRemoteAccess } from '@workstep/gateway-ui/openRemoteAccess'
import { gatewayWorkspacePath } from '../utils/gatewayWorkspacePath'

type Device = {id: string; name: string; online: boolean; project_only?:boolean}
type Project = {id:string;device_id:string;device_name:string;device_online:boolean;name:string}

export default function GatewayDeviceTabs({currentDeviceId,currentProjectId}: {currentDeviceId: string;currentProjectId?:string|null}) {
  const {t} = useI18n()
  const [devices, setDevices] = useState<Device[]>([])
  const [projects,setProjects]=useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [opening, setOpening] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const pending = useRef(false)
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    async function refresh() {
      try {
        if(gatewayWorkspacePath()) {
          const responses=await Promise.all(['/api/devices','/api/projects'].map(url=>fetch(url,{credentials:'same-origin'})))
          if(responses.some(response=>!response.ok))throw Error('Gateway access unavailable')
          const [deviceResult,projectResult]=await Promise.all(responses.map(response=>response.json()))
          const available:Project[]=projectResult.projects ?? []
          const hosts=new Map<string,Device>((deviceResult.devices ?? []).map((device:Device)=>[device.id,device]))
          for(const project of available)if(!hosts.has(project.device_id))hosts.set(project.device_id,{id:project.device_id,name:project.device_name,online:project.device_online,project_only:true})
          if(active){setDevices([...hosts.values()]);setProjects(available);setError('')}
        }else{
          const result = await request<{devices: Device[]}>('/remote/devices')
          if (active) {setDevices(result.devices); setError('')}
        }
      } catch { if (active) setError(t('gatewayRemote.devicesFailed')) }
      finally {if (active) {setLoading(false); timer = setTimeout(() => void refresh(), 20000)}}
    }
    setLoading(true)
    void refresh()
    return () => {active = false; clearTimeout(timer)}
  }, [revision, t])
  async function select(device: Device) {
    if (pending.current || !device.online || device.id === currentDeviceId) return
    pending.current = true; setOpening(device.id); setError('')
    try {
      const project=device.project_only?projects.find(item=>item.device_id===device.id):undefined
      const access = gatewayWorkspacePath()?await fetch(`/api/${project?'projects':'devices'}/${encodeURIComponent(project?.id ?? device.id)}/access`,{credentials:'same-origin'}).then(async response=>{
        if(!response.ok)throw new ApiError('Device unavailable',response.status)
        return response.json()
      }):await request<{url:string;ticket:string}>(`/remote/devices/${encodeURIComponent(device.id)}/access`)
      openRemoteAccess(access)
    } catch (reason) {
      setError(t(reason instanceof ApiError && reason.status === 409 ? 'gatewayRemote.deviceOffline' : 'gatewayRemote.switchFailed'))
      pending.current = false; setOpening(null)
    }
  }
  async function openProject(id:string) {
    if(pending.current)return
    pending.current=true;setOpening(id);setError('')
    try {
      const response=await fetch(`/api/projects/${encodeURIComponent(id)}/access`,{credentials:'same-origin'})
      if(!response.ok)throw Error(t('gatewayRemote.switchFailed'))
      openRemoteAccess(await response.json())
    }catch(reason){setError(reason instanceof Error?reason.message:t('gatewayRemote.switchFailed'));pending.current=false;setOpening(null)}
  }
  return <section className="gateway-direct-device-tabs">
    <DeviceTabs devices={devices} currentDeviceId={currentDeviceId} disabled={opening!==null} disableOffline
      onSelect={id=>{const device=devices.find(item=>item.id===id);if(device)void select(device)}} onRefresh={()=>setRevision(value=>value+1)}/>
    {(opening || (loading && !devices.length)) && <p role="status"><Spinner size={16}/>{t('gatewayRemote.loading')}</p>}
    {!!currentProjectId && <div className="gateway-project-tabs" role="tablist" aria-label="切换授权项目">
      {projects.filter(project=>project.device_id===currentDeviceId).map(project=><button key={project.id} type="button" role="tab"
        aria-selected={project.id===currentProjectId} disabled={opening!==null} onClick={()=>void openProject(project.id)}>{project.name}</button>)}
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>
}
