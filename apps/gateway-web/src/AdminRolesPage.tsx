import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AdminGrantRoleDialog, AdminRevokeRoleDialog } from './AdminRoleDialogs'

export type AdminRole = {
  id: string; user_id: string; username: string; display_name: string; user_status: string
  registration_source: string; role: string; scope_type: string; scope_id: string | null; scope_name?: string | null
  include_subdepartments: boolean; granted_by_user_id: string | null; created_at: string
}

type Filters = { q: string; role: string; sort: string; direction: string; page: number; pageSize: number }

export function buildRoleListQuery(filters: Filters): string {
  const params = new URLSearchParams({ sort: filters.sort, direction: filters.direction,
    page: String(filters.page), page_size: String(filters.pageSize) })
  if (filters.q.trim()) params.set('q', filters.q.trim())
  if (filters.role) params.set('role', filters.role)
  return params.toString()
}

const roleNames: Record<string, string> = {
  super_admin: '超级管理员', identity_admin: '用户与组织管理员',
  org_admin: '组织管理员', department_admin: '部门管理员', device_admin: '设备管理员',
  skill_admin: 'Skill 管理员', audit_admin: '审计管理员',
}

export function AdminRolesPage({ delegated = false }: { delegated?: boolean }) {
  const navigate = useNavigate()
  const [access, setAccess] = useState<'checking' | 'ready' | 'forbidden'>('checking')
  const [csrf, setCsrf] = useState('')
  const [roles, setRoles] = useState<AdminRole[]>([])
  const [total, setTotal] = useState(0)
  const [searchDraft, setSearchDraft] = useState('')
  const [filters, setFilters] = useState<Filters>({ q: '', role: '', sort: 'created_at',
    direction: 'desc', page: 1, pageSize: 25 })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [grantOpen, setGrantOpen] = useState(false)
  const [revoke, setRevoke] = useState<AdminRole | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (response.status === 401) { navigate('/auth?next=%2Fadmin%2Fadmins', { replace: true }); return }
        if (!response.ok) throw new Error('登录状态加载失败。')
        const session = await response.json()
        if (!controller.signal.aborted) { setCsrf(session.csrf_token); setAccess('ready') }
      }).catch(reason => { if (reason?.name !== 'AbortError') setError('登录状态加载失败，请刷新重试。') })
    return () => controller.abort()
  }, [navigate])

  useEffect(() => {
    if (access !== 'ready') return
    const controller = new AbortController()
    setLoading(true); setError('')
    void fetch(`/api/admin/roles?${buildRoleListQuery(filters)}`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then(async response => {
      if (response.status === 401) { navigate('/auth?next=%2Fadmin%2Fadmins', { replace: true }); return }
      if (response.status === 403) { setAccess('forbidden'); return }
      if (!response.ok) throw new Error('管理员列表加载失败。')
      const result = await response.json()
      if (!controller.signal.aborted) { setRoles(result.roles ?? []); setTotal(result.total ?? 0) }
    }).catch(reason => {
      if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '管理员列表加载失败。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [access, filters, revision, navigate])

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setFilters(current => ({ ...current, q: searchDraft.trim(), page: 1 }))
  }
  function refresh() { setRevision(value => value + 1) }
  const pages = Math.max(1, Math.ceil(total / filters.pageSize))

  return <section className="gateway-admin-page">
    <span className="gateway-auth-eyebrow">WORKSTEP 平台 · ADMIN</span>
    <h2>管理员权限</h2>
    {access === 'checking' && <p role="status">正在检查登录状态…</p>}
    {access === 'forbidden' && <p role="alert">当前账号没有管理员权限配置资格，或需要先<Link to="/account">修改初始密码</Link>。</p>}
    {access === 'ready' && <>
      <div className="gateway-admin-toolbar">
        <form className="gateway-admin-search" onSubmit={search}>
          <label htmlFor="admin-role-search">搜索管理员</label>
          <input id="admin-role-search" value={searchDraft} onChange={event => setSearchDraft(event.target.value)}
            placeholder="用户名或显示名称" />
          <button type="submit">搜索</button>
        </form>
        <button type="button" onClick={() => setGrantOpen(true)}>授予权限</button>
      </div>
      <div className="gateway-admin-filters">
        <label htmlFor="admin-role-filter">角色</label>
        <select id="admin-role-filter" value={filters.role} onChange={event => setFilters(current => (
          { ...current, role: event.target.value, page: 1 }))}>
          <option value="">全部</option>{Object.entries(roleNames).filter(([role]) => !delegated || ['identity_admin', 'department_admin', 'audit_admin'].includes(role)).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <label htmlFor="admin-role-sort">排序</label>
        <select id="admin-role-sort" value={filters.sort} onChange={event => setFilters(current => (
          { ...current, sort: event.target.value, page: 1 }))}>
          <option value="created_at">授予时间</option><option value="username">用户名</option><option value="role">角色</option>
        </select>
        <select aria-label="排序方向" value={filters.direction} onChange={event => setFilters(current => (
          { ...current, direction: event.target.value, page: 1 }))}>
          <option value="desc">降序</option><option value="asc">升序</option>
        </select>
      </div>
      {loading && <p role="status">正在加载管理员…</p>}
      {error && <p className="gateway-auth-error" role="alert">{error} <button type="button" onClick={refresh}>重试</button></p>}
      {!loading && !error && roles.length === 0 && <p>当前条件下没有管理员。</p>}
      {!error && <ul className="gateway-device-list gateway-admin-user-list">{roles.map(role => <li key={role.id}>
        <div><strong>{role.display_name}</strong><p>{role.username} · {roleNames[role.role] ?? role.role} · {
          role.scope_type === 'platform' ? '全平台' : `${({ department: '部门', organization: '组织', device_group: '设备组' } as Record<string, string>)[role.scope_type]} ${role.scope_name ?? role.scope_id}${role.scope_type === 'department' && role.include_subdepartments ? '（含下级）' : ''}`
        }</p><p>{role.user_status === 'active' ? '已启用' : role.user_status} · {role.registration_source}</p></div>
        <button type="button" onClick={() => setRevoke(role)}>撤销</button>
      </li>)}</ul>}
      <div className="gateway-admin-pagination">
        <span>共 {total} 项权限 · 第 {filters.page}/{pages} 页</span>
        <button type="button" disabled={filters.page <= 1 || loading} onClick={() => setFilters(current => (
          { ...current, page: current.page - 1 }))}>上一页</button>
        <button type="button" disabled={filters.page >= pages || loading} onClick={() => setFilters(current => (
          { ...current, page: current.page + 1 }))}>下一页</button>
      </div>
    </>}
    {grantOpen && <AdminGrantRoleDialog delegated={delegated} csrf={csrf} onClose={() => setGrantOpen(false)}
      onSaved={() => { setGrantOpen(false); setFilters(current => ({ ...current, page: 1 })); refresh() }} />}
    {revoke && <AdminRevokeRoleDialog role={revoke} csrf={csrf} onClose={() => setRevoke(null)}
      onComplete={() => { setRevoke(null); refresh() }} />}
  </section>
}
