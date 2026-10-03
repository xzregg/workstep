import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AdminCreateUserDialog } from './AdminCreateUserDialog'
import { AdminUserActionDialog } from './AdminUserActionDialog'

export type AdminUser = {
  id: string; username: string; display_name: string; status: 'active' | 'pending' | 'disabled'
  registration_source: string; must_change_password: boolean; created_at: string
}

type Filters = { q: string; status: string; sort: string; direction: string; page: number; pageSize: number }

export function buildUserListQuery(filters: Filters): string {
  const params = new URLSearchParams({ sort: filters.sort, direction: filters.direction,
    page: String(filters.page), page_size: String(filters.pageSize) })
  if (filters.q.trim()) params.set('q', filters.q.trim())
  if (filters.status) params.set('status', filters.status)
  return params.toString()
}

export function AdminUsersPage() {
  const navigate = useNavigate()
  const [access, setAccess] = useState<'checking' | 'ready' | 'forbidden'>('checking')
  const [csrf, setCsrf] = useState('')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [searchDraft, setSearchDraft] = useState('')
  const [filters, setFilters] = useState<Filters>({ q: '', status: '', sort: 'created_at',
    direction: 'desc', page: 1, pageSize: 25 })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)
  const [action, setAction] = useState<{ user: AdminUser; kind: 'approve' | 'disable' } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (response.status === 401) { navigate('/auth?next=%2Fadmin%2Fusers', { replace: true }); return }
        if (!response.ok) throw new Error('登录状态加载失败。')
        const session = await response.json()
        if (!controller.signal.aborted) { setCsrf(session.csrf_token); setAccess('ready') }
      })
      .catch(reason => { if (reason?.name !== 'AbortError') setError('登录状态加载失败，请刷新重试。') })
    return () => controller.abort()
  }, [navigate])

  useEffect(() => {
    if (access !== 'ready') return
    const controller = new AbortController()
    setLoading(true); setError('')
    void fetch(`/api/admin/users?${buildUserListQuery(filters)}`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then(async response => {
      if (response.status === 401) { navigate('/auth?next=%2Fadmin%2Fusers', { replace: true }); return }
      if (response.status === 403) { setAccess('forbidden'); return }
      if (!response.ok) throw new Error('用户列表加载失败。')
      const result = await response.json()
      if (!controller.signal.aborted) { setUsers(result.users ?? []); setTotal(result.total ?? 0) }
    }).catch(reason => {
      if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '用户列表加载失败。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [access, filters, revision, navigate])

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFilters(current => ({ ...current, q: searchDraft.trim(), page: 1 }))
  }

  function refresh() { setRevision(value => value + 1) }
  const pages = Math.max(1, Math.ceil(total / filters.pageSize))

  return <section className="gateway-admin-page">
    <span className="gateway-auth-eyebrow">WORKSTEP 平台 · ADMIN</span>
    <h2>用户管理</h2>
    {access === 'checking' && <p role="status">正在检查登录状态…</p>}
    {access === 'forbidden' && <p role="alert">当前账号没有用户管理权限，或需要先<Link to="/account">修改初始密码</Link>。</p>}
    {access === 'ready' && <>
      <div className="gateway-admin-toolbar">
        <form onSubmit={search} className="gateway-admin-search">
          <label htmlFor="admin-user-search">搜索用户</label>
          <input id="admin-user-search" value={searchDraft} onChange={event => setSearchDraft(event.target.value)}
            placeholder="用户名或显示名称" />
          <button type="submit">搜索</button>
        </form>
        <button type="button" onClick={() => setCreateOpen(true)}>创建用户</button>
      </div>
      <div className="gateway-admin-filters">
        <label htmlFor="admin-user-status">状态</label>
        <select id="admin-user-status" value={filters.status} onChange={event => setFilters(current => (
          { ...current, status: event.target.value, page: 1 }))}>
          <option value="">全部</option><option value="active">已启用</option>
          <option value="pending">待审核</option><option value="disabled">已停用</option>
        </select>
        <label htmlFor="admin-user-sort">排序</label>
        <select id="admin-user-sort" value={filters.sort} onChange={event => setFilters(current => (
          { ...current, sort: event.target.value, page: 1 }))}>
          <option value="created_at">创建时间</option><option value="username">用户名</option>
          <option value="display_name">显示名称</option>
        </select>
        <select aria-label="排序方向" value={filters.direction} onChange={event => setFilters(current => (
          { ...current, direction: event.target.value, page: 1 }))}>
          <option value="desc">降序</option><option value="asc">升序</option>
        </select>
      </div>
      {loading && <p role="status">正在加载用户…</p>}
      {error && <p className="gateway-auth-error" role="alert">{error} <button type="button" onClick={refresh}>重试</button></p>}
      {!loading && !error && users.length === 0 && <p>当前条件下没有用户。</p>}
      {!error && <ul className="gateway-device-list gateway-admin-user-list">{users.map(user => <li key={user.id}>
        <div><strong>{user.display_name}</strong><p>{user.username} · {user.registration_source} · {
          user.status === 'pending' ? '待审核' : user.status === 'disabled' ? '已停用' : '已启用'
        }</p>{user.must_change_password && <p>首次登录需修改密码</p>}</div>
        <div className="gateway-device-actions">
          {user.status === 'pending' && <button type="button" onClick={() => setAction({ user, kind: 'approve' })}>批准</button>}
          {user.status !== 'disabled' && <button type="button" onClick={() => setAction({ user, kind: 'disable' })}>停用</button>}
        </div>
      </li>)}</ul>}
      <div className="gateway-admin-pagination">
        <span>共 {total} 位用户 · 第 {filters.page}/{pages} 页</span>
        <button type="button" disabled={filters.page <= 1 || loading} onClick={() => setFilters(current => (
          { ...current, page: current.page - 1 }))}>上一页</button>
        <button type="button" disabled={filters.page >= pages || loading} onClick={() => setFilters(current => (
          { ...current, page: current.page + 1 }))}>下一页</button>
      </div>
    </>}
    {createOpen && <AdminCreateUserDialog csrf={csrf} onClose={() => setCreateOpen(false)}
      onSaved={() => { setCreateOpen(false); setFilters(current => ({ ...current, page: 1 })); refresh() }} />}
    {action && <AdminUserActionDialog user={action.user} action={action.kind} csrf={csrf}
      onClose={() => setAction(null)} onComplete={() => { setAction(null); refresh() }} />}
  </section>
}
