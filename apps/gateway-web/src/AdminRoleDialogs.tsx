import { useState } from 'react'
import type { FormEvent } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'
import type { AdminRole } from './AdminRolesPage'

type Choice = { id: string; display_name: string; username?: string; external_id?: string; provider?: string }

export function AdminGrantRoleDialog({ csrf, onSaved, onClose }: {
  csrf: string; onSaved: () => void; onClose: () => void
}) {
  const [userQuery, setUserQuery] = useState('')
  const [userChoices, setUserChoices] = useState<Choice[]>([])
  const [userId, setUserId] = useState('')
  const [departmentQuery, setDepartmentQuery] = useState('')
  const [departmentChoices, setDepartmentChoices] = useState<Choice[]>([])
  const [departmentId, setDepartmentId] = useState('')
  const [role, setRole] = useState('identity_admin')
  const [scope, setScope] = useState('platform')
  const [includeChildren, setIncludeChildren] = useState(true)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmClose, setConfirmClose] = useState(false)
  const dirty = !!(userQuery || userId || departmentQuery || departmentId || password || role !== 'identity_admin' || scope !== 'platform')
  const canSubmit = !!(userId && password && (scope === 'platform' || departmentId))

  async function findChoices(kind: 'users' | 'departments', query: string) {
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/admin/${kind}?q=${encodeURIComponent(query.trim())}&page=1&page_size=10`,
        { credentials: 'same-origin' })
      if (!response.ok) throw new Error('搜索失败，请重试。')
      const result = await response.json()
      if (kind === 'users') setUserChoices(result.users ?? [])
      else setDepartmentChoices(result.departments ?? [])
    } catch (reason) { setError(reason instanceof Error ? reason.message : '搜索失败。') }
    finally { setBusy(false) }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit || busy) return
    setBusy(true); setError('')
    try {
      const step = await fetch('/api/auth/step-up', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ password }),
      })
      if (!step.ok) throw new Error('密码验证失败。')
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/roles`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ role, scope_type: scope, scope_id: scope === 'department' ? departmentId : null,
          include_subdepartments: includeChildren }),
      })
      if (!response.ok) throw new Error(response.status === 403 ? '当前权限无法授予此角色。' : '授予角色失败，请重试。')
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '授予角色失败。') }
    finally { setBusy(false) }
  }

  return <div className="gateway-dialog-backdrop"><section className="gateway-confirm-dialog gateway-role-dialog"
    role="dialog" aria-modal="true" aria-label="授予管理员权限">
    <h3>授予管理员权限</h3>
    <form className="gateway-auth-form" onSubmit={event => void submit(event)}>
      <label htmlFor="role-user-search">搜索用户</label>
      <div className="gateway-admin-search">
        <input id="role-user-search" value={userQuery} onChange={event => {
          setUserQuery(event.target.value); setUserId(''); setUserChoices([])
        }}
          placeholder="用户名或显示名称" />
        <button type="button" disabled={busy || !userQuery.trim()} onClick={() => void findChoices('users', userQuery)}>查找用户</button>
      </div>
      {userChoices.length > 0 && <select aria-label="选择用户" value={userId} onChange={event => setUserId(event.target.value)}>
        <option value="">选择用户</option>{userChoices.map(user => <option value={user.id} key={user.id}>
          {user.display_name}（{user.username}）</option>)}
      </select>}
      <label htmlFor="role-kind">管理员角色</label>
      <select id="role-kind" value={role} onChange={event => {
        const next = event.target.value; setRole(next)
        if (next === 'super_admin' || next === 'skill_admin') setScope('platform')
      }}>
        <option value="identity_admin">用户与组织管理员</option><option value="skill_admin">Skill 管理员</option>
        <option value="audit_admin">审计管理员</option><option value="super_admin">超级管理员</option>
      </select>
      <label htmlFor="role-scope">管理范围</label>
      <select id="role-scope" value={scope} disabled={role === 'super_admin' || role === 'skill_admin'}
        onChange={event => { setScope(event.target.value); setDepartmentId('') }}>
        <option value="platform">全平台</option><option value="department">部门</option>
      </select>
      {scope === 'department' && <>
        <label htmlFor="role-department-search">搜索部门</label>
        <div className="gateway-admin-search"><input id="role-department-search" value={departmentQuery}
          onChange={event => { setDepartmentQuery(event.target.value); setDepartmentId(''); setDepartmentChoices([]) }} placeholder="部门名称" />
          <button type="button" disabled={busy || !departmentQuery.trim()}
            onClick={() => void findChoices('departments', departmentQuery)}>查找部门</button></div>
        {departmentChoices.length > 0 && <select aria-label="选择部门" value={departmentId}
          onChange={event => setDepartmentId(event.target.value)}><option value="">选择部门</option>
          {departmentChoices.map(department => <option value={department.id} key={department.id}>
            {department.display_name} · {department.provider} · {department.external_id}</option>)}</select>}
        <label className="gateway-role-checkbox"><input type="checkbox" checked={includeChildren}
          onChange={event => setIncludeChildren(event.target.checked)} /> 包含下级部门</label>
      </>}
      <label htmlFor="role-step-password">输入你的密码确认</label>
      <input id="role-step-password" type="password" autoComplete="current-password" value={password}
        onChange={event => setPassword(event.target.value)} />
      {error && <p className="gateway-auth-error" role="alert">{error}</p>}
      <div className="gateway-dialog-actions">
        <button type="button" className="gateway-dialog-cancel" disabled={busy}
          onClick={() => dirty ? setConfirmClose(true) : onClose()}>取消</button>
        <button type="submit" disabled={busy || !canSubmit}>{busy ? '正在保存…' : '授予权限'}</button>
      </div>
    </form>
    {confirmClose && <GatewayConfirmDialog title="放弃授权" message="已选择的用户与范围将丢失。"
      confirmLabel="放弃并关闭" onConfirm={onClose} onCancel={() => setConfirmClose(false)} />}
  </section></div>
}

export function AdminRevokeRoleDialog({ role, csrf, onComplete, onClose }: {
  role: AdminRole; csrf: string; onComplete: () => void; onClose: () => void
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function confirm() {
    setBusy(true); setError('')
    try {
      const step = await fetch('/api/auth/step-up', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ password }),
      })
      if (!step.ok) throw new Error('密码验证失败。')
      const response = await fetch(`/api/admin/roles/${encodeURIComponent(role.id)}`, {
        method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf },
      })
      if (!response.ok) throw new Error(response.status === 409 ? '必须保留最后一名本地超级管理员。'
        : response.status === 403 ? '恢复管理员受到保护。' : '撤销权限失败，请重试。')
      onComplete()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '撤销权限失败。') }
    finally { setBusy(false) }
  }
  return <GatewayConfirmDialog title="撤销管理员权限" message={`撤销 ${role.display_name} 的 ${role.role} 权限？`}
    confirmLabel="确认撤销" disabled={!password} busy={busy} onConfirm={() => void confirm()} onCancel={onClose}>
    <label htmlFor="revoke-role-password">输入你的密码确认</label>
    <input id="revoke-role-password" type="password" autoComplete="current-password" value={password}
      onChange={event => setPassword(event.target.value)} />
    {error && <p className="gateway-auth-error" role="alert">{error}</p>}
  </GatewayConfirmDialog>
}
