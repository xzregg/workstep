import { useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'
import { GatewayModal } from './GatewayModal'
import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import { PermissionPicker } from './PermissionPicker'

export type PermissionDefinition = { id: string; name: string; category: string; scopes: string[]; effects: string[] }
export type PermissionAssignment = { id: string; subject_type: 'user' | 'group'; subject_id: string; subject_name: string
  permission: string; scope_type: string; scope_id: string | null; scope_name: string; effect: 'allow' | 'deny'; include_subdepartments?: boolean }
export const scopeNames: Record<string, string> = { global: '全局', platform: '整个平台', device: '指定设备',
  project: '指定项目', provider: '指定模型供应商', organization: '指定组织', department: '指定部门', device_group: '指定设备组' }

async function requireSuccess(response: Response, fallback: string) {
  if (response.ok) return
  const data = await response.json().catch(() => null)
  throw new Error(data?.error?.message || fallback)
}

export function PermissionDialog({ catalog, csrf, assignment, preset, onClose, onSaved }: {
  catalog: PermissionDefinition[]; csrf: string; assignment?: PermissionAssignment
  preset?: { scope_type: string; scope_id: string; scope_name: string }; onClose: () => void; onSaved: () => void
}) {
  const [subjectType, setSubjectType] = useState<'user' | 'group'>(assignment?.subject_type ?? 'user')
  const [subjectId, setSubjectId] = useState(assignment?.subject_id ?? '')
  const [permission, setPermission] = useState(assignment?.permission ?? '')
  const [permissions, setPermissions] = useState<string[]>([])
  const [completed, setCompleted] = useState<string[]>([])
  const [scope, setScope] = useState(assignment?.scope_type ?? preset?.scope_type ?? '')
  const [resource, setResource] = useState(assignment?.scope_id ?? preset?.scope_id ?? '')
  const [effect, setEffect] = useState<'allow' | 'deny'>(assignment?.effect ?? 'allow')
  const [children, setChildren] = useState(assignment?.include_subdepartments ?? true)
  const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)
  const definitions = catalog.filter(item => assignment ? item.id === permission : permissions.includes(item.id))
  const definition = definitions[0]
  const scopes = definition?.scopes.filter(value => definitions.every(item => item.scopes.includes(value))) ?? []
  const effects = definition?.effects.filter(value => definitions.every(item => item.effects.includes(value))) ?? ['allow']
  const locked = busy || completed.length > 0
  const projectAccess = assignment?.permission === 'project.read' || assignment?.permission === 'project.edit'
  const noResource = scope === 'global' || scope === 'platform'
  const ready = !!csrf && !!subjectId && !!definition && scopes.includes(scope) && effects.includes(effect)
    && (assignment || permissions.some(id => !completed.includes(id)))
    && (noResource || !!resource) && passwordReady
  const dirty = subjectId !== (assignment?.subject_id ?? '') || subjectType !== (assignment?.subject_type ?? 'user')
    || permission !== (assignment?.permission ?? '') || permissions.length > 0 || scope !== (assignment?.scope_type ?? preset?.scope_type ?? '')
    || resource !== (assignment?.scope_id ?? preset?.scope_id ?? '') || effect !== (assignment?.effect ?? 'allow')
    || children !== (assignment?.include_subdepartments ?? true) || !!password
  async function save() {
    if (!ready || busy) return
    setBusy(true); setError('')
    try {
      const confirmation = await confirmStepUp(csrf, password, passwordRequired)
      if (!confirmation.ok) throw new Error('管理员身份验证失败，请重试。')
      for (const selectedPermission of assignment ? [permission] : permissions.filter(id => !completed.includes(id))) {
      const response = await fetch('/api/admin/permissions', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({
          subject_type: subjectType, subject_id: subjectId, permission: selectedPermission, scope_type: scope,
          scope_id: noResource ? null : resource, effect, include_subdepartments: children,
        }) })
      await requireSuccess(response, `保存“${catalog.find(item => item.id === selectedPermission)?.name ?? selectedPermission}”失败，请重试。`)
      if (!assignment) setCompleted(current => [...current, selectedPermission])
      }
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存权限失败，请重试。') }
    finally { setBusy(false) }
  }
  return <>
    <GatewayModal title={assignment ? '调整权限' : '分配权限'} className="gateway-permission-dialog"
      onClose={() => { if (!busy) dirty ? setDiscard(true) : onClose() }} footer={<>
        <button type="button" disabled={busy} onClick={() => dirty ? setDiscard(true) : onClose()}>取消</button>
        <button type="button" disabled={busy || !ready} onClick={() => void save()}>{busy ? '处理中…' : '保存权限'}</button>
      </>}>
      <p>组权限由当前有效成员继承。超管默认拥有全部权限。</p>
      {assignment ? <p>授权对象：{subjectType === 'user' ? '用户' : '用户组'} · {assignment.subject_name}</p> : <>
        <label htmlFor="permission-subject-type">对象类型</label>
        <select id="permission-subject-type" value={subjectType} disabled={locked} onChange={event => {
          setSubjectType(event.target.value as 'user' | 'group'); setSubjectId('')
        }}><option value="user">用户</option><option value="group">用户组</option></select>
        <PermissionPicker key={subjectType} kind="subject" targetType={subjectType} label="授权对象" value={subjectId} onChange={setSubjectId} disabled={locked} />
      </>}
      {!assignment && <fieldset className="gateway-permission-selection" disabled={locked}>
        <legend>权限（可多选）</legend>
        <p className="gateway-permission-note">所选权限使用同一个授权对象、作用范围和规则；没有共同作用范围的权限请分次分配。</p>
        {[...new Set(catalog.map(item => item.category))].map(category => <div key={category}>
          <h4>{category}</h4>
          {catalog.filter(item => item.category === category).map(item => <label key={item.id} className="gateway-permission-checkbox">
            <input type="checkbox" checked={permissions.includes(item.id)}
              disabled={!permissions.includes(item.id) && definitions.length > 0
                && !item.scopes.some(value => scopes.includes(value))}
              onChange={event => {
                const next = event.target.checked ? [...permissions, item.id] : permissions.filter(id => id !== item.id)
                const selected = catalog.filter(value => next.includes(value.id))
                const common = selected[0]?.scopes.filter(value => selected.every(row => row.scopes.includes(value))) ?? []
                setPermissions(next)
                if (!common.includes(scope)) { setScope(common[0] ?? ''); setResource('') }
                if (!selected.every(row => row.effects.includes(effect))) setEffect('allow')
              }} />{item.name}
          </label>)}
        </div>)}
      </fieldset>}
      {assignment && <><label htmlFor="permission-name">权限</label>
      <select id="permission-name" value={permission} disabled={busy || (!!assignment && !projectAccess)} onChange={event => {
        const next = catalog.find(item => item.id === event.target.value)
        setPermission(event.target.value); setEffect('allow')
        if (next && !next.scopes.includes(scope)) { setScope(next.scopes[0]); setResource('') }
      }}><option value="">请选择权限</option>{[...new Set(catalog.map(item => item.category))].map(category =>
        <optgroup key={category} label={category}>{catalog.filter(item => item.category === category
          && (!projectAccess || item.id === 'project.read' || item.id === 'project.edit')).map(item =>
          <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>)}</select></>}
      <label htmlFor="permission-scope">作用范围</label>
      <select id="permission-scope" value={scope} disabled={locked || !!assignment || !definition} onChange={event => {
        setScope(event.target.value); setResource('')
      }}><option value="">请选择范围</option>{scopes.map(value => <option key={value} value={value}>{scopeNames[value]}</option>)}</select>
      {definition && !noResource && scope && <PermissionPicker key={scope} kind="resource" targetType={scope} label="授权资源" value={resource}
        onChange={setResource} disabled={locked || !!assignment} seed={resource ? { id: resource,
          name: assignment?.scope_name ?? preset?.scope_name ?? resource } : undefined} />}
      <label htmlFor="permission-effect">规则</label>
      <select id="permission-effect" value={effect} disabled={locked || !definition} onChange={event => setEffect(event.target.value as 'allow' | 'deny')}>
        {effects.map(value => <option key={value} value={value}>{value === 'allow' ? '允许' : '禁止'}</option>)}
      </select>
      {definition?.effects.includes('deny') && <p className="gateway-permission-note">个人与组规则共同生效；显式禁止优先于允许。</p>}
      {definitions.some(item => item.id === 'device.access') && <p className="gateway-permission-note">此权限开放整台设备的工作区。只开放一个项目时请选择项目查看或编辑权限。</p>}
      {definitions.some(item => item.id === 'project.read' || item.id === 'project.edit' || (scope === 'project' && item.id === 'task.create'))
        && <p className="gateway-permission-note">项目访问与任务创建分别控制。普通用户创建任务需要项目编辑和创建任务两项权限。</p>}
      {scope === 'department' && definitions.some(item => item.id.startsWith('admin.')) && <label className="gateway-permission-checkbox">
        <input type="checkbox" checked={children} disabled={locked} onChange={event => setChildren(event.target.checked)} /> 包含子部门</label>}
      {completed.length > 0 && <p role="status">已保存 {completed.length} 项权限；重试仅保存尚未成功的项。</p>}
      <PasswordConfirmation label="输入管理员密码确认" value={password} onChange={setPassword} disabled={busy} />
      {busy && <p role="status"><span className="gateway-spinner" aria-hidden="true" /> 正在保存权限…</p>}
      {error && <p role="alert" className="gateway-auth-error">{error}</p>}
    </GatewayModal>
    {discard && <GatewayModal title="放弃权限修改" className="gateway-permission-discard"
      onClose={() => setDiscard(false)} footer={<>
        <button type="button" onClick={() => setDiscard(false)}>取消</button>
        <button type="button" onClick={onClose}>放弃并关闭</button>
      </>}><p>{completed.length ? `已保存 ${completed.length} 项权限，关闭不会撤销这些授权。放弃其余未保存的修改？` : '权限配置尚未保存，确定放弃？'}</p></GatewayModal>}
  </>
}

export function RevokePermissionDialog({ assignment, name, csrf, onClose, onSaved }: {
  assignment: PermissionAssignment; name: string; csrf: string; onClose: () => void; onSaved: () => void
}) {
  const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function revoke() {
    if (!passwordReady || busy) return
    setBusy(true); setError('')
    try {
      const confirmation = await confirmStepUp(csrf, password, passwordRequired)
      if (!confirmation.ok) throw new Error('管理员身份验证失败，请重试。')
      await requireSuccess(await fetch(`/api/admin/permissions/${encodeURIComponent(assignment.id)}`, {
        method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf },
      }), '撤销权限失败，请重试。'); onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '撤销权限失败，请重试。') }
    finally { setBusy(false) }
  }
  return <GatewayConfirmDialog title="撤销权限" message={`撤销 ${assignment.subject_name} 的“${name}”规则（${assignment.scope_name}）？其他个人或组授权仍可能生效。`}
    confirmLabel="撤销权限" busy={busy} disabled={!csrf || !passwordReady} onConfirm={() => void revoke()} onCancel={onClose}>
    <PasswordConfirmation label="输入管理员密码确认" value={password} onChange={setPassword} disabled={busy} />
    {busy && <p role="status"><span className="gateway-spinner" aria-hidden="true" /> 正在撤销权限…</p>}
    {error && <p role="alert" className="gateway-auth-error">{error}</p>}
  </GatewayConfirmDialog>
}
