import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AdminProjectGrantDialog, AdminProjectRevokeDialog } from './AdminProjectGrantDialog'
import type { ProjectGrant } from './AdminProjectGrantDialog'
import { AdminProjectTaskCreatePanel } from './AdminProjectTaskCreatePanel'

type Project = { id: string; name: string; device_id: string; device_name: string;
  device_online: boolean; publisher: string | null; published_at: string | null;
  grant_users: number; grant_groups: number; grant_levels: { read: number; edit: number };
  running_tasks: number | null }
type Filters = { q: string; sort: string; direction: string; page: number }

function ProjectGrants({ project, csrf, onChanged }: { project: Project; csrf: string; onChanged: () => void }) {
  const [grants, setGrants] = useState<ProjectGrant[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [edit, setEdit] = useState<ProjectGrant | 'new' | null>(null)
  const [revoke, setRevoke] = useState<ProjectGrant | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    void fetch(`/api/admin/projects/${encodeURIComponent(project.id)}/grants`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error('项目授权加载失败。')
      const data = await response.json()
      if (!controller.signal.aborted) setGrants(data.grants ?? [])
    }).catch(reason => {
      if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '项目授权加载失败。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [project.id, revision])

  function saved() { setEdit(null); setRevoke(null); setRevision(value => value + 1); onChanged() }
  return <section className="gateway-project-grants">
    <div className="gateway-admin-toolbar"><h3>{project.name} · 访问授权</h3>
      <button type="button" onClick={() => setEdit('new')}>新增授权</button></div>
    {loading && <p role="status">正在加载项目授权…</p>}
    {error && <p role="alert" className="gateway-auth-error">{error} <button type="button"
      onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {!loading && !error && grants.length === 0 && <p>尚无访问授权。</p>}
    <ul className="gateway-device-list">{grants.map(grant => <li key={grant.id}>
      <div><strong>{grant.subject_name}</strong><p>{grant.subject_type === 'user' ? '用户' : '用户组'} · {
        grant.access_level === 'edit' ? '可编辑' : '只读'}</p></div>
      <div className="gateway-device-actions"><button type="button" onClick={() => setEdit(grant)}>调整</button>
        <button type="button" onClick={() => setRevoke(grant)}>撤销</button></div>
    </li>)}</ul>
    {edit && <AdminProjectGrantDialog key={edit === 'new' ? 'new' : edit.id} projectId={project.id}
      grant={edit === 'new' ? undefined : edit} csrf={csrf} onClose={() => setEdit(null)} onSaved={saved} />}
    {revoke && <AdminProjectRevokeDialog grant={revoke} projectId={project.id} csrf={csrf}
      onClose={() => setRevoke(null)} onSaved={saved} />}
  </section>
}

export function AdminProjectsPage() {
  const [csrf, setCsrf] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [total, setTotal] = useState(0)
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<Filters>({ q: '', sort: 'name', direction: 'asc', page: 1 })
  const [selected, setSelected] = useState<Project | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('登录状态已失效，请重新登录。')
        const data = await response.json()
        if (!controller.signal.aborted) setCsrf(data.csrf_token)
      }).catch(reason => {
        if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '登录状态加载失败。')
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!csrf) return
    const controller = new AbortController()
    const params = new URLSearchParams({ q: filters.q, sort: filters.sort, direction: filters.direction,
      page: String(filters.page), page_size: '25' })
    setLoading(true); setError('')
    void fetch(`/api/admin/projects?${params}`, { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(response.status === 403 ? '当前账号没有项目管理权限。' : '项目列表加载失败。')
        const data = await response.json()
        if (!controller.signal.aborted) { setProjects(data.projects ?? []); setTotal(data.total ?? 0) }
      }).catch(reason => {
        if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '项目列表加载失败。')
      }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [csrf, filters, revision])

  return <section className="gateway-admin-page">
    <span className="gateway-auth-eyebrow">WORKSTEP GATEWAY · ADMIN</span>
    <div className="gateway-admin-toolbar"><h2>项目管理</h2><Link to="/admin">返回管理概览</Link></div>
    {!csrf && !error && <p role="status">正在检查登录状态…</p>}
    {csrf && <>
      <p>仅展示已发布项目的元数据。管理权限不会自动授予项目内容访问。</p>
      <form className="gateway-admin-search" onSubmit={event => {
        event.preventDefault(); setFilters(current => ({ ...current, q: query.trim(), page: 1 }))
      }}><label htmlFor="admin-project-search">搜索项目或宿主电脑</label>
        <input id="admin-project-search" value={query} onChange={event => setQuery(event.target.value)} />
        <button type="submit">搜索</button></form>
      <div className="gateway-admin-filters"><label htmlFor="admin-project-sort">排序</label>
        <select id="admin-project-sort" value={filters.sort} onChange={event => setFilters(current => (
          { ...current, sort: event.target.value, page: 1 }))}>
          <option value="name">项目名称</option><option value="published_at">发布时间</option></select>
        <select aria-label="项目排序方向" value={filters.direction} onChange={event => setFilters(current => (
          { ...current, direction: event.target.value, page: 1 }))}>
          <option value="asc">升序</option><option value="desc">降序</option></select></div>
      {loading && <p role="status">正在加载项目…</p>}
      {!loading && !error && projects.length === 0 && <p>当前条件下没有已发布项目。</p>}
      <ul className="gateway-device-list">{projects.map(project => <li key={project.id}>
        <div><strong>{project.name}</strong><p>宿主电脑：{project.device_name} · {
          project.device_online ? '在线' : '离线'} · 发布者：{project.publisher ?? '未知'}</p>
          <p>用户授权 {project.grant_users} · 用户组授权 {project.grant_groups} · 只读 {
            project.grant_levels.read} · 可编辑 {project.grant_levels.edit}</p>
          <p>运行状态：{project.running_tasks === null ? '尚未上报' : `${project.running_tasks} 项任务`}</p></div>
        <button type="button" onClick={() => setSelected(project)}>管理授权</button>
      </li>)}</ul>
      <div className="gateway-admin-pagination"><span>共 {total} 个已发布项目 · 第 {filters.page}/{
        Math.max(1, Math.ceil(total / 25))} 页</span>
        <button type="button" disabled={filters.page <= 1 || loading}
          onClick={() => setFilters(current => ({ ...current, page: current.page - 1 }))}>上一页</button>
        <button type="button" disabled={filters.page >= Math.ceil(total / 25) || loading}
          onClick={() => setFilters(current => ({ ...current, page: current.page + 1 }))}>下一页</button></div>
      {selected && <ProjectGrants key={`grants-${selected.id}`} project={selected} csrf={csrf}
        onChanged={() => setRevision(value => value + 1)} />}
      {selected && <AdminProjectTaskCreatePanel key={`capabilities-${selected.id}`}
        projectId={selected.id} csrf={csrf} />}
    </>}
    {error && <p role="alert" className="gateway-auth-error">{error} {csrf && <button type="button"
      onClick={() => setRevision(value => value + 1)}>重试</button>}</p>}
  </section>
}
