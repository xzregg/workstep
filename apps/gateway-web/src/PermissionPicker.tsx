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
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
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
    : seed && !options.some(option => option.id === seed.id) ? [seed, ...options] : options
  return <div className={`gateway-permission-picker${selected ? ' gateway-permission-picker-multiple' : ''}`}>
    <label htmlFor={selected ? undefined : id} id={`${id}-label`}>{label}</label>
    <form className="gateway-permission-search" onSubmit={event => {
      event.preventDefault(); setPage(1); setSearch(query.trim()); if (!selected) onChange('')
    }}>
      <input aria-label={`搜索${label}`} placeholder={`搜索${label}`} value={query}
        disabled={disabled} onChange={event => setQuery(event.target.value)} />
      <button type="submit" disabled={disabled || loading}>搜索</button>
    </form>
    {selected ? <details className="gateway-project-multi-select" onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() }
    }}>
      <summary aria-labelledby={`${id}-label`} aria-disabled={disabled} onClick={event => { if (disabled) event.preventDefault() }}>
        {selected.length ? `已选 ${selected.length} 个项目：${selected.map(item => item.name).join('、')}` : '请选择项目（可多选）'}
      </summary>
      <fieldset className="gateway-project-multi-options" disabled={disabled || loading}><legend>选择项目</legend>
        {visible.map(option => <label key={option.id}><input type="checkbox" checked={selected.some(item => item.id === option.id)}
          onChange={event => onSelectionChange?.(event.target.checked ? [...selected, option] : selected.filter(item => item.id !== option.id))} />{option.name}</label>)}
        {!visible.length && !loading && <p>没有匹配的项目。</p>}
      </fieldset>
    </details> : <>
    <select id={id} value={value} disabled={disabled || loading} onChange={event => {
      onChange(event.target.value); onNameChange?.(event.target.selectedOptions[0]?.textContent ?? '')
    }}>
      <option value="">请选择</option>{visible.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
    </select>
    </>}
    <div className="gateway-admin-pagination"><span>共 {total} 项 · 第 {page}/{Math.max(1, Math.ceil(total / 25))} 页</span>
      <button type="button" disabled={disabled || loading || page === 1} onClick={() => { setPage(page - 1); if (!selected) onChange('') }}>上一页</button>
      <button type="button" disabled={disabled || loading || page >= Math.ceil(total / 25)} onClick={() => { setPage(page + 1); if (!selected) onChange('') }}>下一页</button>
    </div>
    {loading && <p role="status"><span className="gateway-spinner" aria-hidden="true" /> 正在加载{label}…</p>}
    {error && <p role="alert" className="gateway-auth-error">{error} <button type="button" onClick={() => setRetry(retry + 1)}>重试</button></p>}
  </div>
}
