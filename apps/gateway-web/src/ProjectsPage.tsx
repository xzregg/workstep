import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { openRemoteAccess } from './openRemoteAccess'
import { MyWorkstepWorkspace } from './MyWorkstepWorkspace'
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
  const [opening, setOpening] = useState<string | null>(null)
  const openingRef=useRef(false)
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
    setLoading(true)
    setError('')
    void Promise.all(['/api/devices','/api/projects'].map(url=>fetch(url,{credentials:'same-origin',signal:controller.signal})))
      .then(async ([deviceResponse,response]) => {
        if (response.status === 401 || deviceResponse.status === 401) { navigate('/auth?next=%2F', { replace: true }); return }
        if (!deviceResponse.ok) throw Error('设备列表加载失败，请重试。')
        const assigned=(await deviceResponse.json()).devices ?? []
        if(controller.signal.aborted)return
        if(!assigned.length){navigate('/devices/empty',{replace:true});return}
        setDevices(assigned)
        if (!response.ok) throw new Error('项目列表加载失败。')
        if (!controller.signal.aborted) setProjects((await response.json()).projects ?? [])
      })
      .catch(reason => { if (reason?.name !== 'AbortError') setError(reason.message) })
      .finally(()=>{if(!controller.signal.aborted)setLoading(false)})
    return () => controller.abort()
  }, [status, navigate, retry])

  async function openWorkspace(kind:'project'|'device', id:string) {
    if(openingRef.current)return
    openingRef.current=true
    setOpening(kind+':'+id); setError('')
    try {
      const response = await fetch(`/api/${kind==='project'?'projects':'devices'}/${encodeURIComponent(id)}/access`, {
        credentials: 'same-origin',
      })
      if (response.status === 401) { navigate('/auth?next=%2F'); return }
      if (!response.ok) throw new Error(response.status === 409 ? '设备当前离线，请等待上线后重试。' : '无法打开 WorkStep，请检查访问权限。')
      openRemoteAccess(await response.json())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法打开 WorkStep。')
      setOpening(null)
      openingRef.current=false
    }
  }

  return <section className="gateway-admin-page gateway-my-workstep">
    <span className="gateway-auth-eyebrow">WORKSTEP 平台</span>
    <h2>我的 WorkStep</h2>
    {(location.state as { adminDenied?: boolean } | null)?.adminDenied &&
      <p role="alert">当前账号没有访问该管理页面的权限。</p>}
    {status === 'checking' && <p role="status">正在检查登录状态…</p>}
    {status === 'ready' && <>
      {loading?<p role="status"><span className="gateway-spinner"/> 正在加载工作空间…</p>:!!devices.length && <MyWorkstepWorkspace devices={devices} projects={projects} opening={opening}
       onOpenDevice={id=>void openWorkspace('device',id)} onOpenProject={id=>void openWorkspace('project',id)}/>}
    </>}
    {error && <p className="gateway-auth-error" role="alert">{error} {status==='ready' && <button type="button" disabled={loading || opening!==null} onClick={()=>setRetry(value=>value+1)}>重新加载</button>}</p>}
  </section>
}
