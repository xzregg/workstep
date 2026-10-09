import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { PermissionPicker } from './PermissionPicker'
import { PermissionSubjectTable } from './PermissionSubjectTable'
import { PermissionDialog, RevokePermissionDialog, scopeNames } from './PermissionDialogs'
import type { PermissionAssignment, PermissionDefinition } from './PermissionDialogs'

export function AdminPermissionsPage() {
  const [params] = useSearchParams()
  const [catalog, setCatalog] = useState<PermissionDefinition[]>([])
  const [csrf, setCsrf] = useState('')
  const [subjectType, setSubjectType] = useState(params.get('subject_type') ?? '')
  const [subjectId, setSubjectId] = useState(params.get('subject_id') ?? '')
  const [assignments, setAssignments] = useState<PermissionAssignment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [setupError, setSetupError] = useState('')
  const [revision, setRevision] = useState(0)
  const [retrySetup, setRetrySetup] = useState(0)
  const [edit, setEdit] = useState<PermissionAssignment | 'new' | null>(null)
  const [revoke, setRevoke] = useState<PermissionAssignment | null>(null)
  const scopeType = params.get('scope_type') ?? ''
  const scopeId = params.get('scope_id') ?? ''
  const preset = scopeType && scopeId ? { scope_type: scopeType, scope_id: scopeId,
    scope_name: params.get('scope_name') ?? scopeId } : undefined
  useEffect(() => {
    const controller = new AbortController()
    setSetupError('')
    void Promise.all([
      fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal }),
      fetch('/api/admin/permissions/catalog', { credentials: 'same-origin', signal: controller.signal }),
    ]).then(async ([session, definitions]) => {
      if (!session.ok || !definitions.ok) throw new Error('权限目录加载失败，请重试。')
      const [identity, data] = await Promise.all([session.json(), definitions.json()])
      if (!controller.signal.aborted) { setCsrf(identity.csrf_token ?? ''); setCatalog(data.permissions ?? []) }
    }).catch(reason => { if (reason?.name !== 'AbortError') setSetupError(reason instanceof Error ? reason.message : '权限目录加载失败。') })
    return () => controller.abort()
  }, [retrySetup])
  useEffect(() => {
    const controller = new AbortController()
    const query = new URLSearchParams()
    if (subjectType) query.set('subject_type', subjectType)
    if (subjectType && subjectId) query.set('subject_id', subjectId)
    setLoading(true); setError('')
    void fetch(`/api/admin/permissions${query.size ? `?${query}` : ''}`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error('权限规则加载失败，请重试。')
      const data = await response.json()
      if (!controller.signal.aborted) setAssignments(data.assignments ?? [])
    }).catch(reason => { if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '权限规则加载失败。') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [subjectType, subjectId, revision])
  const visible = assignments.filter(row => !scopeType || (row.scope_type === scopeType && row.scope_id === scopeId))
  const name = (permission: string) => catalog.find(item => item.id === permission)?.name ?? permission
  function saved() { setEdit(null); setRevoke(null); setRevision(value => value + 1) }
  return <section className="gateway-admin-page gateway-permissions-page">
    <div className="gateway-admin-toolbar"><h2>权限管理</h2>
      <button type="button" disabled={!csrf || !catalog.length} onClick={() => setEdit('new')}>分配权限</button></div>
    <p className="gateway-permission-summary">统一分配资源访问、业务操作和平台管理权限。组权限由当前有效成员继承，超管默认拥有全部权限。</p>
    {preset && <p className="gateway-permission-scope-filter">当前范围：{scopeNames[scopeType]} · {preset.scope_name}
      <Link to="/admin/permissions">查看全部范围</Link></p>}
    <div className="gateway-permission-filters">
      <div><label htmlFor="permission-filter-type">对象类型筛选</label>
        <select id="permission-filter-type" value={subjectType} onChange={event => {
          setSubjectType(event.target.value); setSubjectId('')
        }}><option value="">全部用户与组</option><option value="user">用户</option><option value="group">用户组</option></select></div>
      {subjectType && <PermissionPicker key={subjectType} kind="subject" targetType={subjectType}
        label="筛选对象" value={subjectId} onChange={setSubjectId} />}
      <button type="button" onClick={() => setRevision(value => value + 1)} disabled={loading}>刷新规则</button>
    </div>
    {setupError && <p role="alert" className="gateway-auth-error">{setupError} <button type="button" onClick={() => setRetrySetup(value => value + 1)}>重试目录</button></p>}
    {loading && <p role="status"><span className="gateway-spinner" aria-hidden="true" /> 正在加载权限规则…</p>}
    {error && <p role="alert" className="gateway-auth-error">{error} <button type="button" onClick={() => setRevision(value => value + 1)}>重试规则</button></p>}
    {!loading && !error && visible.length === 0 && <p>当前条件下尚无权限规则。点击“分配权限”，选择用户或组、权限和作用范围。</p>}
    {!!visible.length && <PermissionSubjectTable assignments={visible} name={name} canEdit={!!csrf && !!catalog.length}
      canRevoke={!!csrf} onEdit={setEdit} onRevoke={setRevoke} />}
    {!loading && !error && <p className="gateway-permission-note">共 {new Set(visible.map(row => `${row.subject_type}:${row.subject_id}`)).size} 个授权对象，{visible.length} 条直接授权规则。个人与组的业务禁止规则优先；继承权限会随组成员变化更新。</p>}
    {edit && <PermissionDialog key={edit === 'new' ? 'new' : edit.id} catalog={catalog} csrf={csrf} preset={preset}
      assignment={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} onSaved={saved} />}
    {revoke && <RevokePermissionDialog assignment={revoke} name={name(revoke.permission)} csrf={csrf}
      onClose={() => setRevoke(null)} onSaved={saved} />}
  </section>
}
