import { AdminSessionStatus } from './AdminSessionStatus'
import { AdminListStatus } from './AdminListStatus'
import { AdminUserGroupTree } from './AdminUserGroupTree'
import { AdminGroupCreateDialog } from './AdminGroupCreateDialog'
import { AdminUserTable } from './AdminUserTable'
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AdminCreateUserDialog } from './AdminCreateUserDialog'

export type AdminUser = {
  id: string; username: string; display_name: string; status: 'active' | 'pending' | 'disabled' | 'deleted'
  registration_source: string; must_change_password: boolean; created_at: string
  last_login_at?: string | null; login_username?: string | null; is_recovery?: boolean
}

type Filters = { q: string; status: string; sort: string; direction: 'asc' | 'desc'; page: number; pageSize: number; groupId?: string }

export function buildUserListQuery(filters: Filters): string {
  const params = new URLSearchParams({ sort: filters.sort, direction: filters.direction,
    page: String(filters.page), page_size: String(filters.pageSize) })
  if (filters.q.trim()) params.set('q', filters.q.trim())
  if (filters.status) params.set('status', filters.status)
  if (filters.groupId) params.set('group_id', filters.groupId)
  return params.toString()
}

export function AdminUsersPage() {
  const [params] = useSearchParams()
  const linkedStatus = ['pending','active','disabled','deleted'].includes(params.get('status') ?? '') ? params.get('status')! : ''
  const navigate = useNavigate()
  const [access, setAccess] = useState<'checking' | 'ready' | 'forbidden' | 'session-error'>('checking')
  const [sessionRevision, setSessionRevision] = useState(0)
  const [csrf, setCsrf] = useState('')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [searchDraft, setSearchDraft] = useState('')
  const [filters, setFilters] = useState<Filters>({ q: '', status: linkedStatus, sort: 'created_at',
    direction: 'desc', page: 1, pageSize: 100 })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)
  const [groupCreateOpen, setGroupCreateOpen] = useState(false)
  const [superAdmin, setSuperAdmin] = useState(false)
  const [canViewAudit, setCanViewAudit] = useState(false)

  useEffect(() => {
    setFilters(current => current.status === linkedStatus ? current
      : { ...current, status: linkedStatus, page: 1 })
  }, [linkedStatus])

  useEffect(() => {
    const controller = new AbortController()
    setAccess('checking'); setError('')
    void fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (response.status === 401) { navigate('/auth?next=%2Fadmin%2Fusers', { replace: true }); return }
        if (!response.ok) throw new Error('登录状态加载失败。')
        const session = await response.json()
        if (!controller.signal.aborted) { setCsrf(session.csrf_token); setSuperAdmin((session.admin_roles ?? []).includes('super_admin')); setCanViewAudit((session.admin_roles ?? []).some((role: string) => ['super_admin', 'audit_admin'].includes(role))); setAccess('ready') }
      })
      .catch(reason => { if (!controller.signal.aborted) { setError('登录状态加载失败，请重试。'); setAccess('session-error') } })
    return () => controller.abort()
  }, [navigate, sessionRevision])

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
    <h2>{filters.status === 'deleted' ? '用户回收站' : '用户管理'}</h2>
    <div className="gateway-device-actions"><button type="button" onClick={() => setFilters(current => ({ ...current, status: '', groupId: undefined, page: 1 }))}>用户列表</button><button type="button" onClick={() => setFilters(current => ({ ...current, status: 'deleted', groupId: undefined, q: '', page: 1 }))}>回收站</button></div>
    {filters.status === 'deleted' && <p>删除的用户可单项或批量恢复；恢复后为停用状态，可返回用户列表启用。彻底删除需要管理员密码确认，完成后无法恢复。</p>}
    <AdminSessionStatus loading={access === 'checking'} error={access === 'session-error' ? error : ''} onRetry={() => setSessionRevision(value => value + 1)} />
    {access === 'forbidden' && <p role="alert">当前账号没有用户管理权限。</p>}
    {access === 'ready' && <div className="gateway-users-workspace">
      <div className="gateway-users-tree-panel"><AdminUserGroupTree selected={filters.groupId ?? ''} revision={revision} onSelect={groupId => setFilters(current => ({ ...current, groupId, page: 1 }))} />
       {superAdmin && <button type="button" onClick={() => setGroupCreateOpen(true)}>创建用户组</button>}
      </div><div className="gateway-users-table-panel">
      <div className="gateway-admin-toolbar">
        <button type="button" disabled={loading} onClick={refresh}>刷新用户与用户组</button>
        <form onSubmit={search} className="gateway-admin-search">
          <label htmlFor="admin-user-search">搜索用户</label>
          <input id="admin-user-search" value={searchDraft} onChange={event => setSearchDraft(event.target.value)}
            placeholder="用户名或显示名称" />
          <button type="submit">搜索</button>
        </form>
        <button type="button" className="gateway-admin-primary" onClick={() => setCreateOpen(true)}>创建用户</button>
      </div>
      <div className="gateway-admin-filters">
        <label htmlFor="admin-user-status">状态</label>
        <select id="admin-user-status" value={filters.status} onChange={event => setFilters(current => (
          { ...current, status: event.target.value, page: 1 }))}>
          <option value="">全部</option><option value="active">已启用</option>
          <option value="pending">待审核</option><option value="disabled">已停用</option>
          <option value="deleted">已删除</option>
        </select>
        <label htmlFor="admin-user-sort">排序</label>
        <select id="admin-user-sort" value={filters.sort} onChange={event => setFilters(current => (
          { ...current, sort: event.target.value, page: 1 }))}>
          <option value="created_at">创建时间</option><option value="username">用户名</option>
          <option value="display_name">显示名称</option><option value="last_login_at">上次登录时间</option>
        </select>
        <select aria-label="排序方向" value={filters.direction} onChange={event => setFilters(current => (
          { ...current, direction: event.target.value as 'asc' | 'desc', page: 1 }))}>
          <option value="desc">降序</option><option value="asc">升序</option>
        </select>
      </div>
      <AdminListStatus loading={loading} label="正在加载用户…"/>
      {error && <p className="gateway-auth-error" role="alert">{error} <button type="button" onClick={refresh}>重试</button></p>}
      {!loading && !error && users.length === 0 && <p>当前条件下没有用户。</p>}
      {!error && <AdminUserTable users={users} csrf={csrf} loading={loading} resetKey={filters} onRefresh={refresh} canViewAudit={canViewAudit}
        loginSort={filters.sort === 'last_login_at' ? filters.direction : undefined}
        onSortLogin={() => setFilters(current => ({ ...current, sort: 'last_login_at',
          direction: current.sort === 'last_login_at' && current.direction === 'desc' ? 'asc' : 'desc', page: 1 }))}/>}
      <div className="gateway-admin-pagination">
        <span>共 {total} 位用户 · 每页 {filters.pageSize} 位 · 第 {filters.page}/{pages} 页</span>
        <button type="button" disabled={filters.page <= 1 || loading} onClick={() => setFilters(current => (
          { ...current, page: current.page - 1 }))}>上一页</button>
        <button type="button" disabled={filters.page >= pages || loading} onClick={() => setFilters(current => (
          { ...current, page: current.page + 1 }))}>下一页</button>
      </div>
    </div></div>}
    {groupCreateOpen && <AdminGroupCreateDialog csrf={csrf} onClose={() => setGroupCreateOpen(false)} onDone={id => { setGroupCreateOpen(false); setFilters(current => ({ ...current, groupId: id, page: 1 })); refresh() }} />}
    {createOpen && <AdminCreateUserDialog csrf={csrf} onClose={() => setCreateOpen(false)}
      onSaved={() => { setCreateOpen(false); refresh() }} />}
  </section>
}
