import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { PermissionPicker } from './PermissionPicker'
import { PermissionSubjectTable } from './PermissionSubjectTable'
import { PermissionDialog, RevokePermissionDialog, scopeNames } from './PermissionDialogs'
import type { PermissionAssignment, PermissionDefinition } from './PermissionDialogs'
import { ProjectPermissionDialog, type ProjectPermission, type ProjectPermissionSet } from './ProjectPermissionDialog'

export function AdminPermissionsPage({ mode = 'resource' }: { mode?: 'resource' | 'platform' }) {
  const platform = mode === 'platform'
  const [params] = useSearchParams()
  const [catalog, setCatalog] = useState<PermissionDefinition[]>([])
  const [projectCatalog, setProjectCatalog] = useState<ProjectPermission[]>([])
  const [projectSets, setProjectSets] = useState<ProjectPermissionSet[]>([])
  const [legacyNew, setLegacyNew] = useState(false)
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
      if (!controller.signal.aborted) {
        setCsrf(identity.csrf_token ?? ''); setCatalog(data.permissions ?? [])
        setProjectCatalog(data.project_permissions ?? []); setProjectSets(data.project_permission_sets ?? [])
      }
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
  const availableCatalog = catalog.filter(item => item.id.startsWith('admin.') === platform)
  const visible = assignments.filter(row => row.permission.startsWith('admin.') === platform
    && (!scopeType || (row.scope_type === scopeType && row.scope_id === scopeId)))
  const name = (permission: string) => catalog.find(item => item.id === permission)?.name ?? permission
  function saved() { setEdit(null); setLegacyNew(false); setRevoke(null); setRevision(value => value + 1) }
  return <section className="gateway-admin-page gateway-permissions-page">
    <div className="gateway-admin-toolbar"><h2>{platform ? '网关平台权限' : '用户与用户组权限'}</h2>
      <button type="button" disabled={!csrf || !availableCatalog.length} onClick={() => { setLegacyNew(platform); setEdit('new') }}>{platform ? '分配平台权限' : '分配权限'}</button>
      {!platform && !!projectCatalog.length && <button type="button" disabled={!csrf} onClick={() => { setLegacyNew(true); setEdit('new') }}>资源与业务权限</button>}</div>
    <p className="gateway-permission-summary">{platform ? '分配网关后台管理权限，包括用户管理、设备管理、Skills 管理和审计等。组权限由当前有效成员继承。' : '分配用户与用户组的项目操作、设备访问、供应商使用和业务权限。组权限由当前有效成员继承。'}</p>
    {preset && <p className="gateway-permission-scope-filter">当前范围：{scopeNames[scopeType]} · {preset.scope_name}
      <Link to={platform ? "/admin/platform-permissions" : "/admin/permissions"}>查看全部范围</Link></p>}
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
    {!loading && !error && visible.length === 0 && <p>当前条件下尚无权限规则。点击“{platform ? '分配平台权限' : '分配权限'}”，选择用户或组、权限和作用范围。</p>}
    {!!visible.length && <PermissionSubjectTable assignments={visible} name={name} canEdit={!!csrf && !!availableCatalog.length}
      canRevoke={!!csrf} onEdit={setEdit} onRevoke={setRevoke} />}
    {!loading && !error && <p className="gateway-permission-note">共 {new Set(visible.map(row => `${row.subject_type}:${row.subject_id}`)).size} 个授权对象，{visible.length} 条直接授权规则。{!platform && '个人与组的业务禁止规则优先；'}继承权限会随组成员变化更新。</p>}
    {edit && !platform && projectCatalog.length > 0 && !legacyNew && (edit === 'new' ? !preset || preset.scope_type === 'project' : edit.id.startsWith('project:')) ?
      <ProjectPermissionDialog key={edit === 'new' ? 'new' : edit.id} catalog={projectCatalog} sets={projectSets} csrf={csrf} preset={preset}
        assignment={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} onSaved={saved} /> : edit &&
      <PermissionDialog key={edit === 'new' ? 'new' : edit.id} catalog={availableCatalog} csrf={csrf} preset={preset}
      assignment={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} onSaved={saved} />}
    {revoke && <RevokePermissionDialog assignment={revoke} name={name(revoke.permission)} csrf={csrf}
      onClose={() => setRevoke(null)} onSaved={saved} />}
  </section>
}
