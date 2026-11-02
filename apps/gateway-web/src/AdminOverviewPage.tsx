import { useEffect, useState, type ReactNode } from 'react'
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

type IconName = 'users' | 'devices' | 'projects' | 'tasks' | 'refresh'
function OverviewIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    devices: 'M4 3h16a1 1 0 0 1 1 1v12H3V4a1 1 0 0 1 1-1ZM8 21h8M12 16v5',
    projects: 'M3 7V4h6l2 3h10v13H3V7Z',
    tasks: 'M3 12h4l3-8 4 16 3-8h4',
    refresh: 'M20 7a9 9 0 1 0 1 8M20 3v5h-5',
  }
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}
function Metric({ title, icon, value, unit, children, link }: {
  title: string; icon: IconName; value: number | string; unit: string; children: ReactNode; link?: ReactNode
}) {
  return <section className="gateway-overview-metric">
    <div className="gateway-overview-metric-heading"><h3>{title}</h3><span className="gateway-overview-icon"><OverviewIcon name={icon} /></span></div>
    <div className="gateway-overview-value"><strong>{value}</strong><span>{unit}</span></div>
    <div className="gateway-overview-metric-detail">{children}</div>
    <div className="gateway-overview-metric-footer">{link || <span>基于项目最近上报状态</span>}</div>
  </section>
}
function Attention({ title, count, description, to }: { title: string; count: number; description: string; to: string }) {
  return <div className="gateway-overview-attention-row">
    <span className={count > 0 ? 'gateway-overview-count is-warning' : 'gateway-overview-count'}>{count}</span>
    <div><Link to={to}>{title}<span aria-hidden="true"> ↗</span></Link><p>{description}</p></div>
  </div>
}
const actionLabels: Record<string, string> = { 'auth.desktop.login': '桌面端登录', 'auth.device.login': '设备登录', 'auth.login': '用户登录', 'auth.logout': '用户退出' }
const resultLabels: Record<string, string> = { success: '成功', failure: '失败', failed: '失败', error: '错误', denied: '拒绝' }

export function AdminOverviewPage() {
  const navigate = useNavigate()
  const [overview, setOverview] = useState<Overview | null>(null)
  const [access, setAccess] = useState<'checking' | 'ready' | 'forbidden'>('checking')
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setError('')
    setLoading(true)
    void fetch('/api/admin/overview', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (response.status === 401) { navigate('/auth?next=%2Fadmin', { replace: true }); return }
        if (response.status === 403) { setAccess('forbidden'); setOverview(null); return }
        if (!response.ok) throw new Error('管理概览加载失败。')
        const data = await response.json()
        if (!controller.signal.aborted) { setOverview(data); setAccess('ready'); setUpdatedAt(new Date()) }
      }).catch(reason => {
        if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '管理概览加载失败。')
      }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [navigate, revision])

  const devices = overview?.devices
  const canManageProjects = overview?.roles.some(role => ['super_admin', 'org_admin', 'department_admin'].includes(role))
  return <section className="gateway-admin-page gateway-overview-page">
    <header className="gateway-overview-header">
      <div><span className="gateway-overview-eyebrow">WORKSTEP / 管理工作台</span><h2>管理概览</h2><p>掌握平台运行状况，及时处理审批与异常。</p></div>
      <div className="gateway-overview-refresh"><span>{updatedAt ? `更新于 ${updatedAt.toLocaleTimeString('zh-CN', { hour12: false })}` : '平台状态快照'}</span>
        <button type="button" onClick={() => setRevision(value => value + 1)} disabled={loading || access === 'forbidden'} aria-label="刷新概览"><span className={loading ? 'gateway-overview-spinning' : ''}><OverviewIcon name="refresh" /></span>{loading ? '刷新中' : '刷新概览'}</button></div>
    </header>
    {access === 'checking' && !error && <div className="gateway-overview-empty" role="status">正在加载管理概览…</div>}
    {access === 'forbidden' && <p role="alert">当前账号没有管理后台权限。</p>}
    {error && <p className="gateway-auth-error" role="alert">{error} <button type="button" disabled={loading}
      onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {access === 'ready' && overview && <div aria-busy={loading}>
      <div className="gateway-overview-metrics">
        {overview.users && <Metric title="用户" icon="users" value={overview.users.total} unit="位用户" link={<Link to="/admin/users">管理用户 <span aria-hidden="true">↗</span></Link>}>
          <span className={overview.users.pending ? 'gateway-overview-warning' : ''}>{overview.users.pending} 位待审核</span>
        </Metric>}
        {devices && <Metric title="受管电脑" icon="devices" value={devices.online} unit="台在线" link={<Link to="/admin/devices">管理设备 <span aria-hidden="true">↗</span></Link>}>
          共 {devices.total} 台设备 <span className="gateway-overview-divider">/</span> {devices.offline} 台离线
        </Metric>}
        {overview.projects && <Metric title="项目" icon="projects" value={overview.projects.published} unit="个已发布" link={canManageProjects ? <Link to="/admin/projects">管理项目 <span aria-hidden="true">↗</span></Link> : <span>当前权限范围内的项目</span>}>
          {overview.projects.shared} 个已共享
        </Metric>}
        <Metric title="运行中任务" icon="tasks" value={overview.tasks.running ?? '—'} unit={overview.tasks.running === null ? '待上报' : '项'}>
          {overview.tasks.running === null ? '运行状态尚未全部上报' : '当前已上报的运行中任务'}
        </Metric>
      </div>
      <div className="gateway-overview-panels">
        {devices && <section className="gateway-overview-panel">
          <div className="gateway-overview-section-heading"><div><h3>设备运行状况</h3><p>控制连接与后台服务分别统计</p></div><span className="gateway-overview-tag">{devices.total} 台受管</span></div>
          <div className="gateway-overview-connectivity"><div><span className="gateway-overview-dot" />控制连接在线</div><strong>{devices.online}<small> / {devices.total}</small></strong></div>
          <progress className="gateway-overview-progress" max={Math.max(devices.total, 1)} value={devices.online} aria-label="控制连接在线设备占比" />
          <p className="gateway-overview-health-caption">{devices.online} 台控制连接在线 · {devices.offline} 台离线 · {devices.pending} 台待审批</p>
          <div className="gateway-overview-health-grid">
            <div><span><i className="gateway-overview-dot" />服务正常</span><strong>{devices.daemon_healthy}<small>台</small></strong></div>
            <div><span><i className="gateway-overview-dot is-warning" />服务异常</span><strong>{devices.daemon_unhealthy}<small>台</small></strong></div>
            <div><span><i className="gateway-overview-dot is-unknown" />状态未知</span><strong>{devices.daemon_unknown}<small>台</small></strong></div>
          </div>
          <p className="gateway-overview-health-caption">daemon 健康：{devices.daemon_healthy} 台正常 · {devices.daemon_unhealthy} 台异常 · {devices.daemon_unknown} 台未知</p>
        </section>}
        <section className="gateway-overview-panel">
          <div className="gateway-overview-section-heading"><div><h3>待处理事项</h3><p>当前权限范围内的审批与运行提醒</p></div></div>
          <div className="gateway-overview-attention">
            {overview.users && <Attention title="待审核用户" count={overview.users.pending} description={overview.users.pending ? '审核注册申请，确认用户访问资格' : '当前无待审核用户'} to="/admin/users?status=pending" />}
            {devices && <>
              <Attention title="待审批设备" count={devices.pending} description={devices.pending ? '确认新设备的接入申请' : '当前无待审批设备'} to="/admin/devices?status=pending" />
              <Attention title="异常设备" count={devices.daemon_unhealthy} description={devices.daemon_unhealthy ? '检查设备后台服务的运行状况' : '当前未报告后台服务异常'} to="/admin/devices?health=unhealthy" />
            </>}
            {overview.projects && overview.projects.host_offline > 0 && <p className="gateway-overview-notice">{overview.projects.host_offline} 个项目的宿主电脑离线</p>}
            {overview.tasks.unknown_projects !== null && overview.tasks.unknown_projects > 0 && <p className="gateway-overview-notice">{overview.tasks.unknown_projects} 个项目状态未知</p>}
            {!overview.users && !devices && !overview.projects && !overview.tasks.unknown_projects && <p className="gateway-overview-empty">当前可见范围内暂无待处理事项。</p>}
          </div>
        </section>
      </div>
      {overview.recent_actions && <section className="gateway-overview-panel gateway-overview-audit">
        <div className="gateway-overview-section-heading"><div><h3>最近关键操作</h3><p>平台访问与管理操作记录</p></div><Link to="/admin/audit">查看全部审计记录 <span aria-hidden="true">↗</span></Link></div>
        {overview.recent_actions.length === 0 ? <p className="gateway-overview-empty">暂无操作记录。平台产生关键操作后将在此显示。</p> : <ul className="gateway-overview-events">{overview.recent_actions.map((action, index) =>
          <li key={`${action.created_at}-${index}`}>
            <span className="gateway-overview-event-icon"><OverviewIcon name={action.action.includes('device') ? 'devices' : 'users'} /></span>
            <div className="gateway-overview-event-name"><strong>{actionLabels[action.action] || action.action}</strong>{actionLabels[action.action] && <code>{action.action}</code>}</div>
            <span className={`gateway-overview-tag ${action.result === 'success' ? 'is-success' : ['failure', 'failed', 'error', 'denied'].includes(action.result) ? 'is-warning' : ''}`}>{resultLabels[action.result] || action.result}</span>
            <time dateTime={action.created_at}>{new Date(action.created_at).toLocaleString('zh-CN', { hour12: false })}</time>
          </li>)}</ul>}
      </section>}
    </div>}
  </section>
}
