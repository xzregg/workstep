import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { GatewayLoginForm } from './GatewayLoginForm'
import { openRemoteAccess } from './openRemoteAccess'

type Project = { id: string; name: string; device_id: string; access_level: 'read' | 'edit' }

export function ProjectsPage() {
  const [status, setStatus] = useState<'checking' | 'login' | 'ready'>('checking')
  const [projects, setProjects] = useState<Project[]>([])
  const [busy, setBusy] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setStatus(response.ok ? 'ready' : 'login') })
      .catch(reason => { if (reason?.name !== 'AbortError') setStatus('login') })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (status !== 'ready') return
    const controller = new AbortController()
    void fetch('/api/projects', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('项目列表加载失败。')
        if (!controller.signal.aborted) setProjects((await response.json()).projects ?? [])
      })
      .catch(reason => { if (reason?.name !== 'AbortError') setError(reason.message) })
    return () => controller.abort()
  }, [status])

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
    } catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败。') }
    finally { setBusy(false) }
  }

  async function openProject(projectId: string) {
    setOpening(projectId); setError('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/access`, {
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(response.status === 409 ? '项目所在电脑当前离线。' : '无法打开这个项目。')
      openRemoteAccess(await response.json())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法打开这个项目。')
      setOpening(null)
    }
  }

  return <section className="gateway-admin-page">
    <span className="gateway-auth-eyebrow">WORKSTEP GATEWAY</span>
    <h2>我的项目</h2>
    {status === 'checking' && <p role="status">正在检查登录状态…</p>}
    {status === 'login' && <div className="gateway-admin-login">
      <p>登录后查看获授权的远程项目。</p>
      <GatewayLoginForm busy={busy} onSubmit={signIn} />
    </div>}
    {status === 'ready' && <>
      {projects.length === 0 && <div className="gateway-empty-devices">
        <p>你还没有获授权的远程项目。</p><Link to="/devices">查看我的电脑</Link>
      </div>}
      <ul className="gateway-device-list">{projects.map(project => <li key={project.id}>
        <div><strong>{project.name}</strong><p>{project.access_level === 'edit' ? '可编辑' : '只读'} · {project.device_id}</p></div>
        <button type="button" disabled={opening !== null} onClick={() => void openProject(project.id)}>
          {opening === project.id ? '正在打开…' : '打开项目'}
        </button>
      </li>)}</ul>
    </>}
    {error && <p className="gateway-auth-error" role="alert">{error}</p>}
  </section>
}
