import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { DirectWorkstepWorkspace } from './DirectWorkstepWorkspace'
import type { WorkspaceDevice } from './MyWorkstepWorkspace'

import type { Project } from './ProjectCard'
export { ProjectCard } from './ProjectCard'

export function ProjectsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [status, setStatus] = useState<'checking' | 'ready'>('checking')
  const [projects, setProjects] = useState<Project[]>([])
  const [devices,setDevices]=useState<WorkspaceDevice[]>([])
  const [loading,setLoading]=useState(true)
  const [retry,setRetry]=useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
      .then(response => {
        if (controller.signal.aborted) return
        if (response.status === 401) {
          navigate('/auth?next=%2F', { replace: true })
          return
        }
        if (!response.ok) throw Error('登录状态检查失败，请刷新重试。')
        setStatus('ready')
      })
      .catch(reason => { if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '登录状态检查失败。') })
    return () => controller.abort()
  }, [navigate])

  useEffect(() => {
    if (status !== 'ready') return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    setError('')
    async function refresh() {
    await Promise.all(['/api/devices','/api/projects'].map(url=>fetch(url,{credentials:'same-origin',signal:controller.signal})))
      .then(async ([deviceResponse,response]) => {
        if (response.status === 401 || deviceResponse.status === 401) { navigate('/auth?next=%2F', { replace: true }); return }
        if (!deviceResponse.ok) throw Error('设备列表加载失败，请重试。')
        if (!response.ok) throw new Error('项目列表加载失败。')
        const assigned:WorkspaceDevice[]=(await deviceResponse.json()).devices ?? []
        const available:Project[]=(await response.json()).projects ?? []
        if(controller.signal.aborted)return
        if(!assigned.length && !available.length){navigate('/devices/empty',{replace:true});return}
        const hosts=new Map(assigned.map(device=>[device.id,device]))
        for(const project of available) if(!hosts.has(project.device_id)) hosts.set(project.device_id,{
          id:project.device_id,name:project.device_name,online:project.device_online,project_only:true,
        })
        setDevices([...hosts.values()])
        setProjects(available)
        setError('')
      })
      .catch(reason => { if (reason?.name !== 'AbortError') setError(reason.message) })
      .finally(()=>{if(!controller.signal.aborted){setLoading(false);timer=setTimeout(() => void refresh(),10000)}})
    }
    void refresh()
    return () => {controller.abort();clearTimeout(timer)}
  }, [status, navigate, retry])

  return <section className="gateway-admin-page gateway-my-workstep">
    <h2 className="gateway-workspace-heading">我的 WorkStep</h2>
    {(location.state as { adminDenied?: boolean } | null)?.adminDenied &&
      <p role="alert">当前账号没有访问该管理页面的权限。</p>}
    {status === 'checking' && <p role="status">正在检查登录状态…</p>}
    {status === 'ready' && <>
      {loading && !devices.length?<p role="status"><span className="gateway-spinner"/> 正在加载工作空间…</p>:!!devices.length && <DirectWorkstepWorkspace devices={devices} projects={projects}/>}
    </>}
    {error && <p className="gateway-auth-error" role="alert">{error} {status==='ready' && <button type="button" disabled={loading} onClick={()=>setRetry(value=>value+1)}>重新加载</button>}</p>}
  </section>
}
