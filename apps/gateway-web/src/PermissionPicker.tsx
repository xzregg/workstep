import Select from './GatewaySelect'
import { useEffect, useId, useState } from 'react'

type Option = { id: string; name: string }

export function PermissionPicker({ kind, targetType, label, value, onChange, onNameChange, seed, selected, onSelectionChange, disabled = false }: {
  kind: 'subject' | 'resource'; targetType: string; label: string; value: string
  onChange: (value: string) => void; seed?: Option; disabled?: boolean
  onNameChange?: (name: string) => void
  selected?: Option[]; onSelectionChange?: (options: Option[]) => void
}) {
  const id = useId()
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [options, setOptions] = useState<Option[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [chosen, setChosen] = useState<Option | undefined>(seed)
  useEffect(() => { setChosen(undefined) }, [kind, targetType])
  useEffect(() => {
    const timer = window.setTimeout(() => { setPage(1); setSearch(query.trim()) }, 250)
    return () => window.clearTimeout(timer)
  }, [query])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setOptions([])
    const params = new URLSearchParams({ [kind === 'subject' ? 'subject_type' : 'scope_type']: targetType,
      q: search, page: String(page), page_size: '25' })
    void fetch(`/api/admin/permissions/${kind === 'subject' ? 'subjects' : 'resources'}?${params}`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error(`${label}加载失败。`)
      const data = await response.json()
      if (!controller.signal.aborted) { setOptions(data[kind === 'subject' ? 'subjects' : 'resources'] ?? []); setTotal(data.total ?? 0) }
    }).catch(reason => {
      if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '加载失败。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [kind, targetType, search, page, retry, label])
  const visible = selected ? [...selected.filter(item => !options.some(option => option.id === item.id)), ...options]
    : (chosen ?? seed) && !options.some(option => option.id === (chosen ?? seed)!.id) ? [(chosen ?? seed)!, ...options] : options
  return <div className={`gateway-permission-picker${selected ? ' gateway-permission-picker-multiple' : ''}`}>
    <label htmlFor={id}>{label}</label>
    <Select id={id} multiple={!!selected} value={selected ? selected.map(item => item.id) : value}
      placeholder={selected ? '请选择项目（可多选）' : '请选择'} disabled={disabled} loading={loading} onSearchChange={setQuery}
      onChange={event => {
        if (selected) {
          onSelectionChange?.(Array.from(event.target.selectedOptions, option => ({ id: option.value, name: option.textContent ?? option.value })))
        } else {
          const option = visible.find(item => item.id === event.target.value)
          setChosen(option); onChange(event.target.value); onNameChange?.(option?.name ?? '')
        }
      }}>
      {!selected && <option value="">请选择</option>}
      {visible.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
    </Select>
    <div className="gateway-admin-pagination"><span>共 {total} 项 · 第 {page}/{Math.max(1, Math.ceil(total / 25))} 页</span>
      <button type="button" disabled={disabled || loading || page === 1} onClick={() => { setPage(page - 1); if (!selected) onChange('') }}>上一页</button>
      <button type="button" disabled={disabled || loading || page >= Math.ceil(total / 25)} onClick={() => { setPage(page + 1); if (!selected) onChange('') }}>下一页</button>
    </div>
    {loading && <p role="status"><span className="gateway-spinner" aria-hidden="true" /> 正在加载{label}…</p>}
    {error && <p role="alert" className="gateway-auth-error">{error} <button type="button" onClick={() => setRetry(retry + 1)}>重试</button></p>}
  </div>
}
