import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

type Overview = {
  roles: string[]
  users: { total: number; pending: number } | null
  devices: { total: number; online: number; offline: number; pending: number;
    daemon_healthy: number; daemon_unhealthy: number; daemon_unknown: number } | null
  projects: { published: number; shared: number; host_offline: number } | null
  tasks: { running: number | null; unknown_projects: number | null }
  recent_actions: Array<{ action: string; result: string; created_at: string }> | null
}

export function AdminOverviewPage() {
  const navigate = useNavigate()
  const [overview, setOverview] = useState<Overview | null>(null)
  const [access, setAccess] = useState<'checking' | 'ready' | 'forbidden'>('checking')
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setError('')
    void fetch('/api/admin/overview', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (response.status === 401) { navigate('/auth?next=%2Fadmin', { replace: true }); return }
        if (response.status === 403) { setAccess('forbidden'); return }
        if (!response.ok) throw new Error('管理概览加载失败。')
        const data = await response.json()
        if (!controller.signal.aborted) { setOverview(data); setAccess('ready') }
      }).catch(reason => {
        if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '管理概览加载失败。')
      })
    return () => controller.abort()
  }, [navigate, revision])

  return <section className="gateway-admin-page">
    <span className="gateway-auth-eyebrow">WORKSTEP GATEWAY · ADMIN</span>
    <div className="gateway-admin-toolbar"><h2>管理概览</h2><Link to="/">返回工作台</Link></div>
    {access === 'checking' && !error && <p role="status">正在加载管理概览…</p>}
    {access === 'forbidden' && <p role="alert">当前账号没有管理后台权限，或需要先<Link to="/account">修改初始密码</Link>。</p>}
    {error && <p className="gateway-auth-error" role="alert">{error} <button type="button"
      onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {access === 'ready' && overview && <>
      <nav className="gateway-admin-links" aria-label="管理模块">
        {overview.users && <Link to="/admin/users">用户管理</Link>}
        {overview.users && <Link to="/admin/org">组织与同步</Link>}
        {overview.roles.includes('super_admin') && <Link to="/admin/admins">管理员权限</Link>}
        {overview.devices && <Link to="/admin/devices">设备管理</Link>}
        {overview.roles.includes('super_admin') && <Link to="/admin/projects">项目管理</Link>}
        {overview.roles.includes('super_admin') && <Link to="/admin/providers">供应商管理</Link>}
        {overview.roles.includes('super_admin') && <Link to="/admin/usage">Token 用量</Link>}
        {overview.roles.some(role => role === 'super_admin' || role === 'audit_admin') &&
          <Link to="/admin/audit">审计记录</Link>}
        {overview.roles.includes('super_admin') && <Link to="/admin/settings">平台设置</Link>}
      </nav>
      <div className="gateway-overview-grid">
        {overview.users && <section className="gateway-overview-card"><h3>用户</h3>
          <p><strong>{overview.users.total}</strong> 位用户</p>
          <p>{overview.users.pending} 位待审核</p></section>}
        {overview.devices && <section className="gateway-overview-card"><h3>受管电脑</h3>
          <p><strong>{overview.devices.online}</strong> 台控制连接在线 · 共 {overview.devices.total} 台</p>
          <p>{overview.devices.offline} 台离线 · {overview.devices.pending} 台待审批</p>
          <p>daemon 健康：{overview.devices.daemon_healthy} 台正常 · {
            overview.devices.daemon_unhealthy} 台异常 · {overview.devices.daemon_unknown} 台未知</p></section>}
        {overview.projects && <section className="gateway-overview-card"><h3>项目</h3>
          <p><strong>{overview.projects.published}</strong> 个已发布 · {overview.projects.shared} 个已共享</p>
          <p>{overview.projects.host_offline} 个项目的宿主电脑离线</p></section>}
        <section className="gateway-overview-card"><h3>运行中任务</h3>
          <p>{overview.tasks.running === null ? '运行状态尚未全部上报' : `${overview.tasks.running} 项`}</p>
          {overview.tasks.unknown_projects !== null && overview.tasks.unknown_projects > 0 &&
            <p>{overview.tasks.unknown_projects} 个项目状态未知</p>}</section>
      </div>
      {overview.recent_actions && <section className="gateway-overview-activity"><h3>最近关键操作</h3>
        {overview.recent_actions.length === 0 ? <p>暂无操作记录。</p> : <ul>{overview.recent_actions.map((action, index) =>
          <li key={`${action.created_at}-${index}`}><strong>{action.action}</strong> · {action.result} · {
            new Date(action.created_at).toLocaleString()}</li>)}</ul>}
      </section>}
    </>}
  </section>
}
