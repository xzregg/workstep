import { useState } from 'react'
import { GatewayModal } from './GatewayModal'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'
import { PermissionPicker } from './PermissionPicker'
import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import type { PermissionAssignment } from './PermissionDialogs'

export type ProjectPermission = { id: string; name: string; description: string; category: string }
export type ProjectPermissionSet = { id: string; name: string; description: string; permissions: string[] }
export function ProjectPermissionDialog({ catalog, sets, csrf, assignment, preset, onClose, onSaved }: {
  catalog: ProjectPermission[]; sets: ProjectPermissionSet[]; csrf: string; assignment?: PermissionAssignment
  preset?: { scope_type: string; scope_id: string; scope_name: string }; onClose: () => void; onSaved: () => void
}) {
  const initialAllow = assignment?.ui_permissions?.allow ?? (assignment
    ? catalog.filter(item => assignment.permission === 'project.read' ? item.id.endsWith('.read') : !['task.create', 'task.copy', 'task.ai_create', 'task.start_on_create', 'share.create', 'share.manage'].includes(item.id)).map(item => item.id)
    : sets.find(set => set.id === 'creator')?.permissions ?? [])
  const initialDeny = assignment?.ui_permissions?.deny ?? []
  const [allow, setAllow] = useState(initialAllow)
  const [deny, setDeny] = useState(initialDeny)
  const [subjectType, setSubjectType] = useState<'user' | 'group'>(assignment?.subject_type ?? 'user')
  const [subjectId, setSubjectId] = useState(assignment?.subject_id ?? '')
  const [subjectName, setSubjectName] = useState(assignment?.subject_name ?? '')
  const [projectId, setProjectId] = useState(assignment?.scope_id ?? (preset?.scope_type === 'project' ? preset.scope_id : ''))
  const [projectName, setProjectName] = useState(assignment?.scope_name ?? (preset?.scope_type === 'project' ? preset.scope_name : ''))
  const categories = [...new Set(catalog.map(item => item.category))]
  const [category, setCategory] = useState(categories[0])
  const [query, setQuery] = useState('')
  const [effect, setEffect] = useState<'allow' | 'deny'>('allow')
  const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)
  const dirty = subjectId !== (assignment?.subject_id ?? '') || subjectType !== (assignment?.subject_type ?? 'user')
    || projectId !== (assignment?.scope_id ?? (preset?.scope_type === 'project' ? preset.scope_id : ''))
    || [...allow].sort().join() !== [...initialAllow].sort().join() || [...deny].sort().join() !== [...initialDeny].sort().join() || !!password
  const currentSet = deny.length ? undefined : sets.find(set => set.permissions.length === allow.length && set.permissions.every(key => allow.includes(key)))
  const selected = effect === 'allow' ? allow : deny
  const visible = catalog.filter(item => query.trim()
    ? `${item.name} ${item.description} ${item.id} ${item.category}`.toLowerCase().includes(query.trim().toLowerCase()) : item.category === category)
  const close = () => { if (!busy) dirty ? setDiscard(true) : onClose() }
  function toggle(key: string, checked: boolean) {
    const update = (current: string[]) => checked ? [...current, key] : current.filter(value => value !== key)
    if (effect === 'allow') { setAllow(update); if (checked) setDeny(current => current.filter(value => value !== key)) }
    else { setDeny(update); if (checked) setAllow(current => current.filter(value => value !== key)) }
  }
  async function save() {
    if (busy || !csrf || !subjectId || !projectId || !passwordReady || (!allow.length && !deny.length)) return
    setBusy(true); setError('')
    try {
      const step = await confirmStepUp(csrf, password, passwordRequired)
      if (!step.ok) throw new Error('管理员身份验证失败，请重试。')
      const response = await fetch('/api/admin/permissions/project-set', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ subject_type: subjectType, subject_id: subjectId, project_id: projectId, allow, deny }) })
      if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.error?.message || '保存项目权限失败，请重试。') }
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存项目权限失败，请重试。') }
    finally { setBusy(false) }
  }
  return <>
    <GatewayModal title={assignment ? '调整项目权限' : '分配权限'} className="gateway-project-permission-dialog" onClose={close}
      footer={<><span className="gateway-project-permission-footer-note">仅控制项目工作区入口，接口沿用现有授权。</span>
        <button type="button" disabled={busy} onClick={close}>取消</button>
        <button type="button" disabled={busy || !csrf || !subjectId || !projectId || !passwordReady || (!allow.length && !deny.length)} onClick={() => void save()}>
          {busy ? <><span className="gateway-spinner" aria-hidden="true" /> 保存中…</> : '保存权限'}</button></>}>
      <div className="gateway-project-permission-context">
        <div className="gateway-permission-field"><label htmlFor="project-permission-subject-type">对象类型</label>
          <select id="project-permission-subject-type" disabled={busy || !!assignment} value={subjectType} onChange={event => {
            setSubjectType(event.target.value as 'user' | 'group'); setSubjectId(''); setSubjectName('')
          }}><option value="user">用户</option><option value="group">用户组</option></select></div>
        <PermissionPicker key={subjectType} kind="subject" targetType={subjectType} label="授权对象" value={subjectId}
          onChange={setSubjectId} onNameChange={setSubjectName} disabled={busy || !!assignment}
          seed={assignment ? { id: subjectId, name: subjectName } : undefined} />
        <PermissionPicker kind="resource" targetType="project" label="指定项目" value={projectId}
          onChange={setProjectId} onNameChange={setProjectName} disabled={busy || !!assignment}
          seed={projectId ? { id: projectId, name: projectName || projectId } : undefined} />
      </div>
      <div className="gateway-project-permission-presets" aria-label="权限集合">{sets.map(set => <button key={set.id} type="button"
        disabled={busy} aria-pressed={currentSet?.id === set.id} onClick={() => { setAllow([...set.permissions]); setDeny([]); setEffect('allow') }}>
        <strong>{set.name}</strong><span>{set.description}</span></button>)}</div>
      <div className="gateway-project-permission-workspace">
        <nav className="gateway-project-permission-nav" aria-label="功能分类">{categories.map(value => <button key={value} type="button"
          aria-pressed={category === value} onClick={() => { setCategory(value); setQuery('') }}>{value}
          <span>{catalog.filter(item => item.category === value && (allow.includes(item.id) || deny.includes(item.id))).length}</span></button>)}</nav>
        <section className="gateway-project-permission-details" aria-label="权限明细">
          <div className="gateway-project-permission-tools"><input type="search" aria-label="搜索权限" placeholder="搜索功能或权限名称"
            value={query} onChange={event => setQuery(event.target.value)} />
            <select aria-label="正在配置的规则" value={effect} disabled={busy} onChange={event => setEffect(event.target.value as 'allow' | 'deny')}>
              <option value="allow">允许</option><option value="deny">禁止</option></select></div>
          <p className="gateway-permission-note">勾选当前规则；个人与组的显式禁止优先。集合仅提供快捷选择。</p>
          <fieldset disabled={busy} className="gateway-project-permission-options"><legend className="gateway-project-permission-legend">{query ? '搜索结果' : category} · {effect === 'allow' ? '允许' : '禁止'}</legend>
            {visible.map(item => <label className="gateway-project-permission-option" key={item.id}>
              <input type="checkbox" checked={selected.includes(item.id)} aria-label={item.name} onChange={event => toggle(item.id, event.target.checked)} />
              <span><strong>{item.name}</strong><small>{item.description}</small></span></label>)}
            {!visible.length && <p className="gateway-permission-note">没有匹配的权限，请尝试其他关键词。</p>}
          </fieldset>
        </section>
        <aside className="gateway-project-permission-review" aria-label="本次分配">
          <h4>本次分配</h4><dl><dt>授权对象</dt><dd>{subjectId ? subjectName || subjectId : '尚未选择'}</dd>
            <dt>指定项目</dt><dd>{projectId ? projectName || projectId : '尚未选择'}</dd><dt>权限集合</dt><dd>{currentSet ? currentSet.name : '自定义权限'}</dd></dl>
          <p aria-live="polite">允许 {allow.length} 项 · 禁止 {deny.length} 项</p>
          <div className="gateway-project-permission-selected">{catalog.filter(item => allow.includes(item.id) || deny.includes(item.id)).map(item => <button type="button" key={item.id}
            disabled={busy} aria-label={`移除${item.name}`} onClick={() => { setAllow(current => current.filter(key => key !== item.id)); setDeny(current => current.filter(key => key !== item.id)) }}>
            <span>{deny.includes(item.id) ? '禁止 · ' : ''}{item.name}</span><span aria-hidden="true">×</span></button>)}</div>
          <button type="button" disabled={busy || (!allow.length && !deny.length)} onClick={() => { setAllow([]); setDeny([]) }}>清空选择</button>
          <p className="gateway-permission-note">只授予指定项目，不开放整台设备。未勾选的能力不由本条授权提供。</p>
          <PasswordConfirmation label="输入管理员密码确认" value={password} onChange={setPassword} disabled={busy} />
          {error && <p role="alert" className="gateway-auth-error">{error}</p>}
        </aside>
      </div>
    </GatewayModal>
    {discard && <GatewayConfirmDialog title="放弃权限修改" message="权限配置尚未保存，确定放弃？" confirmLabel="放弃并关闭"
      onCancel={() => setDiscard(false)} onConfirm={onClose} />}
  </>
}
