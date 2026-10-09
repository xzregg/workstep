import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { ProjectInvitationJoinForm } from './ProjectInvitationJoinForm'
import { ProjectInvitationRecords } from './ProjectInvitationRecords'
import { invitationHeaders, invitationResponse, useInvitationSession } from './projectInvitationApi'

type Project = { id: string; name: string; device_name: string; invitations_enabled: boolean }

export function ProjectInvitationsPage() {
  const { session, status, retry } = useInvitationSession()
  const location = useLocation()
  const [params] = useSearchParams()
  const [tab, setTab] = useState<'add' | 'share' | 'records'>(params.has('project_id') ? 'share' : 'add')
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState(params.get('project_id') ?? '')
  const [loading, setLoading] = useState(false)
  const [loadRevision, setLoadRevision] = useState(0)
  const [accessLevel, setAccessLevel] = useState('read')
  const [expiresAt, setExpiresAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [created, setCreated] = useState<{ id: string; url: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [revision, setRevision] = useState(0)
  const selected = projects.find(p => p.id === projectId)

  useEffect(() => {
    if (status !== 'ready') return
    const controller = new AbortController()
    setLoading(true); setLoadError('')
    void fetch('/api/project-invitations/projects', { signal: controller.signal })
      .then(invitationResponse).then(data => {
        if (controller.signal.aborted) return
        setProjects(data.projects)
        setProjectId(current => data.projects.some((p: Project) => p.id === current) ? current : data.projects[0]?.id ?? '')
      }).catch(reason => { if (reason?.name !== 'AbortError') setLoadError(reason.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [status, loadRevision])

  async function create(event: FormEvent) {
    event.preventDefault()
    if (!selected?.invitations_enabled || !session || busy) return
    setBusy(true); setError(''); setCopied(false)
    try {
      const result = await invitationResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/invitations`, {
        method: 'POST', headers: invitationHeaders(session.csrf_token),
        body: JSON.stringify({ access_level: accessLevel, expires_at: expiresAt ? new Date(expiresAt).toISOString() : null }),
      }))
      setCreated(result); setRevision(value => value + 1)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '生成邀请失败，请重试。') }
    finally { setBusy(false) }
  }

  async function copy() {
    if (!created) return
    try { await navigator.clipboard.writeText(created.url); setCopied(true) }
    catch { setError('复制失败，请手动选择链接复制。') }
  }

  return <section className="gateway-admin-page gateway-project-invitations">
    <h2>项目分享与添加</h2>
    <div className="gateway-project-invitation-tabs" role="tablist" aria-label="项目分享与添加">
      {([['add', '添加项目'], ['share', '分享项目'], ['records', '我的邀请']] as const).map(([key, label]) =>
        <button key={key} type="button" role="tab" id={`invitation-tab-${key}`}
          aria-controls="invitation-tab-panel" aria-selected={tab === key} tabIndex={tab === key ? 0 : -1}
          onClick={() => setTab(key)} onKeyDown={event => {
            const keys = ['add', 'share', 'records'] as const
            const index = keys.indexOf(key)
            const next = event.key === 'ArrowRight' ? (index + 1) % 3
              : event.key === 'ArrowLeft' ? (index + 2) % 3
              : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null
            if (next === null) return
            event.preventDefault(); setTab(keys[next])
            document.getElementById(`invitation-tab-${keys[next]}`)?.focus()
          }}>{label}</button>)}
    </div>
    <div role="tabpanel" id="invitation-tab-panel" aria-labelledby={`invitation-tab-${tab}`}>
    {tab === 'add' && <ProjectInvitationJoinForm />}
    {status === 'loading' && <p role="status"><span className="gateway-spinner" /> 正在检查登录状态…</p>}
    {status === 'error' && <p role="alert">登录状态加载失败。<button onClick={retry}>重试</button></p>}
    {status === 'login' && <p>生成或接受邀请前，请先<Link to={`/auth?next=${encodeURIComponent(location.pathname + location.search)}`}>登录 / 注册</Link>。</p>}
    {status === 'ready' && tab !== 'add' && <section className="gateway-project-invitation-section">
      {tab === 'share' && <><h3>分享我的项目</h3>
      <p>设备主人可分享已发布项目；对方通过网关邀请链接登录并添加，无需管理员逐个授权。</p></>}
      {loading && <p role="status"><span className="gateway-spinner" /> 正在加载项目…</p>}
      {loadError && <p role="alert">{loadError} <button onClick={() => setLoadRevision(v => v + 1)}>重试加载</button></p>}
      {!loading && !loadError && !projects.length && <p>你没有可分享的已发布项目。请在自己的 WorkStep「项目配置 → 分享 → 访问授权」中发布项目；没有设备也可通过“添加项目”标签加入别人分享的项目。</p>}
      {!!projects.length && <>
        {tab === 'share' && <>
        <form className="gateway-auth-form" onSubmit={event => void create(event)}>
          <label htmlFor="invitation-project">分享项目</label>
          <select id="invitation-project" disabled={busy} value={projectId} onChange={event => {
            setProjectId(event.target.value); setCreated(null); setError(''); setCopied(false)
          }}>{projects.map(p => <option key={p.id} value={p.id}>{p.name} · {p.device_name}</option>)}</select>
          <label htmlFor="invitation-access-level">访问级别</label>
          <select id="invitation-access-level" value={accessLevel} onChange={event => setAccessLevel(event.target.value)}>
            <option value="read">只读</option><option value="edit">可编辑</option>
          </select>
          <label htmlFor="invitation-expiry">邀请过期时间（可选）</label>
          <input id="invitation-expiry" type="datetime-local" value={expiresAt} onChange={event => setExpiresAt(event.target.value)} />
          <p>过期时间限制添加项目的时间；已加入用户的访问持续到授权被撤销。可编辑权限仍受平台任务创建和模型权限约束。</p>
          {selected && !selected.invitations_enabled && <p role="alert">管理员已禁止通过邀请加入这个项目。</p>}
          {error && <p role="alert" className="gateway-auth-error">{error}</p>}
          <button type="submit" disabled={busy || loading || !selected?.invitations_enabled}>
            {busy && <span className="gateway-spinner" />}{busy ? '正在生成…' : '生成项目邀请'}
          </button>
        </form>
        {created && <div className="gateway-project-invitation-created">
          <label htmlFor="created-project-invitation">项目邀请链接</label>
          <input id="created-project-invitation" readOnly value={created.url} />
          <button type="button" onClick={() => void copy()}>{copied ? '已复制' : '复制链接'}</button>
          <p>请保存此链接，列表不会再次显示完整链接。拥有链接的已登录用户可以确认添加。</p>
        </div>}
        </>}
        {tab === 'records' && <>
          <div className="gateway-auth-form">
            <label htmlFor="records-project">项目</label>
            <select id="records-project" value={projectId} onChange={event => {
              setProjectId(event.target.value); setCreated(null); setCopied(false); setError('')
            }}>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name} · {p.device_name}</option>)}
            </select>
          </div>
        {selected && session && <ProjectInvitationRecords key={projectId} projectId={projectId}
          csrf={session.csrf_token} revision={revision} onChanged={() => setCreated(null)} />}
        </>}
      </>}
    </section>}
    </div>
  </section>
}
