import { useEffect, useState } from 'react'

export const roleScopes: Record<string, { type: string; label: string }[]> = {
  super_admin: [{ type: 'platform', label: '全平台' }],
  skill_admin: [{ type: 'platform', label: '全平台' }],
  identity_admin: [{ type: 'platform', label: '全平台' }, { type: 'department', label: '部门' }],
  org_admin: [{ type: 'platform', label: '全组织' }, { type: 'organization', label: '指定组织' }],
  department_admin: [{ type: 'department', label: '部门' }],
  device_admin: [{ type: 'platform', label: '全设备' }, { type: 'device_group', label: '设备组' }],
  audit_admin: [{ type: 'platform', label: '全平台' }, { type: 'department', label: '部门' },
    { type: 'organization', label: '指定组织' }, { type: 'device_group', label: '设备组' }],
}

type Choice = { id: string; label: string }
export function AdminRoleScopePicker({ role, scope, scopeId, disabled, onChange, departmentOnly = false }: {
  role: string; scope: string; scopeId: string; disabled: boolean; departmentOnly?: boolean
  onChange: (scope: string, id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [choices, setChoices] = useState<Choice[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    setChoices([]); setError('')
    if (scope === 'platform') return
    const controller = new AbortController()
    setLoading(true)
    const endpoint = scope === 'department' ? 'departments' : scope === 'organization' ? 'identity-sources' : 'device-groups'
    void fetch(`/api/admin/${endpoint}?q=${encodeURIComponent(search)}&page_size=100`,
      { credentials: 'same-origin', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('管理范围加载失败，请重试。')
      const result = await response.json()
      const rows = result.departments ?? result.sources ?? result.groups ?? []
      if (!controller.signal.aborted) setChoices(rows.map((row: Record<string, string>) => ({
        id: row.id, label: row.display_name ?? row.name ?? `${row.provider} · ${row.tenant_id}`,
      })))
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '管理范围加载失败。') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [scope, search])
  return <>
    <label htmlFor="role-scope">管理范围</label>
    <select id="role-scope" value={scope} disabled={disabled} onChange={event => onChange(event.target.value, '')}>
      {roleScopes[role].filter(item => !departmentOnly || item.type === 'department').map(item => <option key={item.type} value={item.type}>{item.label}</option>)}
    </select>
    {scope !== 'platform' && <>
      <label htmlFor="role-scope-query">搜索管理范围</label>
      <div className="gateway-admin-search"><input id="role-scope-query" value={query} disabled={disabled}
        onChange={event => setQuery(event.target.value)} />
        <button type="button" disabled={disabled || loading} onClick={() => setSearch(query.trim())}>查找范围</button></div>
      <select aria-label="选择管理范围" value={scopeId} disabled={disabled || loading}
        onChange={event => onChange(scope, event.target.value)}>
        <option value="">选择管理范围</option>{choices.map(choice => <option value={choice.id} key={choice.id}>{choice.label}</option>)}
      </select>
      {loading && <p role="status"><span className="gateway-spinner" aria-hidden="true" />正在加载范围…</p>}
      {error && <p className="gateway-auth-error" role="alert">{error}</p>}
    </>}
  </>
}
