import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AdminUsageSummary } from './AdminUsageSummary'
import { AdminUsageEvents } from './AdminUsageEvents'

type Filters = { from_time: string; to_time: string; user_id: string; device_id: string;
  project_id: string; provider_id: string; model: string; source: string;
  metering_status: string }
const emptyFilters: Filters = { from_time: '', to_time: '', user_id: '', device_id: '',
  project_id: '', provider_id: '', model: '', source: '', metering_status: '' }

export function AdminUsagePage() {
  const [draft, setDraft] = useState<Filters>(emptyFilters)
  const [filters, setFilters] = useState('')
  const [error, setError] = useState('')

  function update(field: keyof Filters, value: string) {
    setDraft(current => ({ ...current, [field]: value }))
  }
  function apply() {
    const from = draft.from_time ? new Date(draft.from_time) : null
    const to = draft.to_time ? new Date(draft.to_time) : null
    if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))
        || (from && to && from >= to)) {
      setError('结束时间必须晚于开始时间。'); return
    }
    setError('')
    const params = new URLSearchParams()
    for (const [field, value] of Object.entries(draft)) {
      if (!value.trim()) continue
      params.set(field, field === 'from_time' ? from!.toISOString()
        : field === 'to_time' ? to!.toISOString() : value.trim())
    }
    setFilters(params.toString())
  }

  return <section className="gateway-admin-page">
    <span className="gateway-auth-eyebrow">WORKSTEP GATEWAY · ADMIN</span>
    <div className="gateway-admin-toolbar"><h2>Token 用量</h2><Link to="/admin">返回管理概览</Link></div>
    <p>统计来自 PC 回传或供应商对账；未完成计量单独显示，缺失的 Token 和成本不会计为零。</p>
    <form className="gateway-usage-filters" onSubmit={event => { event.preventDefault(); apply() }}>
      <label>开始时间<input type="datetime-local" value={draft.from_time}
        onChange={event => update('from_time', event.target.value)} /></label>
      <label>结束时间<input type="datetime-local" value={draft.to_time}
        onChange={event => update('to_time', event.target.value)} /></label>
      <label>用户 ID<input value={draft.user_id} maxLength={64}
        onChange={event => update('user_id', event.target.value)} /></label>
      <label>PC ID<input value={draft.device_id} maxLength={64}
        onChange={event => update('device_id', event.target.value)} /></label>
      <label>项目 ID<input value={draft.project_id} maxLength={64}
        onChange={event => update('project_id', event.target.value)} /></label>
      <label>供应商 ID<input value={draft.provider_id} maxLength={64}
        onChange={event => update('provider_id', event.target.value)} /></label>
      <label>模型<input value={draft.model} maxLength={128}
        onChange={event => update('model', event.target.value)} /></label>
      <label>计量来源<select value={draft.source} onChange={event => update('source', event.target.value)}>
        <option value="">全部</option><option value="reported_by_device">PC 回传</option>
        <option value="provider_reconciled">供应商对账</option></select></label>
      <label>计量状态<select value={draft.metering_status}
        onChange={event => update('metering_status', event.target.value)}>
        <option value="">全部</option><option value="metered">已计量</option>
        <option value="unmetered">未完成计量</option></select></label>
      <div className="gateway-usage-filter-actions"><button type="submit">查询用量</button>
        <button type="button" onClick={() => { setDraft(emptyFilters); setFilters(''); setError('') }}>清除筛选</button></div>
    </form>
    {error && <p role="alert" className="gateway-auth-error">{error}</p>}
    <AdminUsageSummary key={`summary-${filters}`} filters={filters} />
    <AdminUsageEvents key={`events-${filters}`} filters={filters} />
  </section>
}
