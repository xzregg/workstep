import { useEffect, useId, useState } from 'react'

type Option = { id: string; label: string }

export function AuditEntityFilter({ kind, value, onChange }: {
  kind: 'user' | 'device'; value: string; onChange: (value: string) => void
}) {
  const label = kind === 'user' ? '用户' : '设备'
  const id = useId()
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<{ q: string; revision: number } | null>(null)
  const [options, setOptions] = useState<Option[]>([])
  const [selectedLabel, setSelectedLabel] = useState<Option | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [more, setMore] = useState(false)

  useEffect(() => {
    if (!value) { setSelectedLabel(null); setQuery(''); setOptions([]); setSearch(null); setError('') }
  }, [value])
  useEffect(() => {
    if (!search) { setLoading(false); return }
    const controller = new AbortController()
    setLoading(true); setError('')
    const params = new URLSearchParams({ kind, q: search.q })
    void fetch(`/api/admin/audit/filter-options?${params}`, { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(response.status === 403 ? '没有审计查询权限。' : `${label}搜索失败，请重试。`)
        const data = await response.json()
        if (!controller.signal.aborted) { setOptions(data.items ?? []); setMore(!!data.has_more) }
      }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '搜索失败。') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [kind, label, search])

  function find() { setSearch(current => ({ q: query.trim(), revision: (current?.revision ?? 0) + 1 })) }
  return <div className="gateway-audit-entity-filter">
    <label htmlFor={id}>{label}</label>
    <div className="gateway-audit-entity-search">
      <input id={id} value={query} maxLength={128} placeholder={kind === 'user' ? '姓名或登录用户名' : '设备名称'}
        onChange={event => {
          setQuery(event.target.value); setSearch(null); setOptions([]); setError('')
        }} onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Enter') { event.preventDefault(); find() }
        }} />
      <button type="button" disabled={loading} onClick={find}>查找{label}</button>
    </div>
    {value && <div className="gateway-audit-entity-selected"><span title={value}>已选：{selectedLabel?.id === value ? selectedLabel.label : value}</span><button type="button" onClick={() => onChange('')}>清除{label}</button></div>}
    {loading && <span role="status"><span className="gateway-spinner" aria-hidden="true" />正在搜索…</span>}
    {error && <span role="alert">{error}<button type="button" onClick={find}>重试{label}搜索</button></span>}
    {!loading && !error && search && <div className="gateway-audit-entity-results" aria-label={`${label}搜索结果`}>
      {options.map(option => <button key={option.id} type="button" title={option.id} onClick={() => {
        setSelectedLabel(option); onChange(option.id); setSearch(null); setOptions([])
      }}>{option.label}</button>)}
      {options.length === 0 && <span>没有可见的匹配{label}。可展开精确筛选输入 ID。</span>}
      {more && <span>仅显示前 20 项，请输入更完整的名称。</span>}
    </div>}
  </div>
}
