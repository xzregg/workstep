import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { GatewayLoginForm } from './GatewayLoginForm'
import { openRemoteAccess } from './openRemoteAccess'
import { MyWorkstepWorkspace } from './MyWorkstepWorkspace'
import type { WorkspaceDevice } from './MyWorkstepWorkspace'

import type { Project } from './ProjectCard'
export { ProjectCard } from './ProjectCard'

export function ProjectsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [status, setStatus] = useState<'checking' | 'login' | 'ready'>('checking')
  const [projects, setProjects] = useState<Project[]>([])
  const [devices,setDevices]=useState<WorkspaceDevice[]>([])
  const [loading,setLoading]=useState(true)
  const [retry,setRetry]=useState(0)
  const [busy, setBusy] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const openingRef=useRef(false)
  const [error, setError] = useState('')
  const [passwordEnabled,setPasswordEnabled]=useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (controller.signal.aborted) return
        if (response.status === 401) {
          const platform = await fetch('/api/platform/status', { signal: controller.signal })
          if (controller.signal.aborted) return
          if (platform.ok && !(await platform.json()).initialized) {
            navigate('/auth', { replace: true }); return
          }
          const policy=await fetch('/api/auth/registration-policy',{signal:controller.signal})
          if(!policy.ok)throw Error('登录方式加载失败，请进入登录页重试。')
          const data=await policy.json()
          if(!controller.signal.aborted)setPasswordEnabled(data.password_login_enabled ?? true)
        }
        if (!controller.signal.aborted) setStatus(response.ok ? 'ready' : 'login')
      })
      .catch(reason => { if (reason?.name !== 'AbortError') setStatus('login') })
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

  async function signIn(username: string, password: string) {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!response.ok) throw new Error('登录失败，请检查账号和密码。')
      setStatus('ready')
      window.dispatchEvent(new Event('gateway-auth-changed'))
    } catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败。') }
    finally { setBusy(false) }
  }

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
    {status === 'login' && <div className="gateway-admin-login">
      <p>登录后进入你的 WorkStep，查看设备和项目。</p>
      {passwordEnabled && <GatewayLoginForm busy={busy} onSubmit={signIn} />}
      <p><Link to="/auth">{passwordEnabled?'注册账号或使用企业身份登录':'扫码登录'}</Link></p>
    </div>}
    {status === 'ready' && <>
      {loading?<p role="status"><span className="gateway-spinner"/> 正在加载工作空间…</p>:!!devices.length && <MyWorkstepWorkspace devices={devices} projects={projects} opening={opening}
       onOpenDevice={id=>void openWorkspace('device',id)} onOpenProject={id=>void openWorkspace('project',id)}/>}
    </>}
    {error && <p className="gateway-auth-error" role="alert">{error} {status==='ready' && <button type="button" disabled={loading || opening!==null} onClick={()=>setRetry(value=>value+1)}>重新加载</button>}</p>}
  </section>
}
