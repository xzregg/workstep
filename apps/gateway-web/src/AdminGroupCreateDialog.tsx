import { useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

export function AdminGroupCreateDialog({ csrf, onDone, onClose }: {
  csrf: string; onDone: (id: string) => void; onClose: () => void
}) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [description, setDescription] = useState('')
  const [sourceType, setSourceType] = useState<'manual' | 'external_department'>('manual')
  const [departmentQuery, setDepartmentQuery] = useState('')
  const [departments, setDepartments] = useState<Array<{ id: string; display_name: string; provider: string }>>([])
  const [departmentId, setDepartmentId] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)
  const dirty = Boolean(name || slug || description || password || departmentId || departmentQuery)
  const valid = Boolean(csrf && password && name && name.trim() === name
    && /^[a-z0-9][a-z0-9_-]*$/.test(slug)
    && (sourceType === 'manual' || departmentId))

  async function searchDepartments() {
    try {
      const response = await fetch(`/api/admin/departments?${new URLSearchParams({
        q: departmentQuery.trim(), page_size: '25',
      })}`, { credentials: 'same-origin' })
      if (!response.ok) throw new Error('部门搜索失败。')
      const result = await response.json()
      setDepartments(result.departments ?? []); setError('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '部门搜索失败。') }
  }

  async function submit() {
    if (!valid || busy) return
    setBusy(true); setError('')
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
    try {
      const step = await fetch('/api/auth/step-up', { method: 'POST',
        credentials: 'same-origin', headers, body: JSON.stringify({ password }) })
      if (!step.ok) throw new Error('管理员密码验证失败。')
      const response = await fetch('/api/groups', { method: 'POST', credentials: 'same-origin',
        headers, body: JSON.stringify({ name, slug, description, source_type: sourceType,
          external_department_id: sourceType === 'external_department' ? departmentId : null }) })
      if (!response.ok) throw new Error(response.status === 409
        ? '用户组标识已存在。' : '创建用户组失败。')
      const created = await response.json()
      onDone(created.id)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建用户组失败。')
    } finally { setBusy(false) }
  }

  return <><GatewayConfirmDialog title="创建用户组" message="创建手工组或映射现有外部部门；成员和项目关联可在创建后配置。"
    confirmLabel="确认创建" busy={busy} disabled={!valid} onConfirm={() => void submit()}
    onCancel={() => dirty ? setDiscard(true) : onClose()}>
    <div className="gateway-usage-filters">
      <label>名称<input value={name} maxLength={256} onChange={event => setName(event.target.value)} /></label>
      <label>标识<input value={slug} maxLength={128} onChange={event => setSlug(event.target.value)} /></label>
      <label>说明<input value={description} maxLength={2000}
        onChange={event => setDescription(event.target.value)} /></label>
      <label>来源<select value={sourceType} onChange={event => {
        setSourceType(event.target.value as 'manual' | 'external_department'); setDepartmentId('')
      }}><option value="manual">手工用户组</option>
        <option value="external_department">外部部门映射</option></select></label>
      {sourceType === 'external_department' && <>
        <label>搜索部门<input value={departmentQuery} maxLength={128}
          onChange={event => setDepartmentQuery(event.target.value)} /></label>
        <button type="button" onClick={() => void searchDepartments()}>查找部门</button>
        <label>映射部门<select value={departmentId} onChange={event => setDepartmentId(event.target.value)}>
          <option value="">选择部门</option>{departments.map(item => <option key={item.id} value={item.id}>
            {item.display_name} · {item.provider}</option>)}</select></label>
      </>}
      <label>管理员密码<input type="password" autoComplete="current-password" value={password}
        onChange={event => setPassword(event.target.value)} /></label>
    </div>
    {busy && <p role="status"><span className="gateway-spinner" aria-hidden="true" /> 正在创建用户组…</p>}
    {error && <p role="alert" className="gateway-auth-error">{error}</p>}
  </GatewayConfirmDialog>
  {discard && <GatewayConfirmDialog title="放弃创建用户组" message="已填写的字段将被清除。"
    confirmLabel="放弃并关闭" cancelLabel="继续编辑" onConfirm={onClose}
    onCancel={() => setDiscard(false)} />}</>
}
