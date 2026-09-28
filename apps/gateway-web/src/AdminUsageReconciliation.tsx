import { useState } from 'react'

type Row = { day: string; provider_id: string; model: string | null; status: string;
  device_event_count: number; provider_line_count: number; unmetered_count: number;
  device_input_tokens: number | null; device_output_tokens: number | null;
  provider_input_tokens: number | null; provider_output_tokens: number | null;
  input_tokens_difference: number | null; output_tokens_difference: number | null;
  estimated_cost: string | null; billed_cost: string | null;
  cost_difference: string | null; currency: string | null }

const statusNames: Record<string, string> = {
  awaiting_provider: '等待供应商账单', missing_device: '缺少 PC 回传',
  incomplete: '未完成计量', incomparable: '币种不可比较',
  matched: '一致', different: '差异',
}

export function AdminUsageReconciliation() {
  const [providerId, setProviderId] = useState('')
  const [fromDay, setFromDay] = useState('')
  const [toDay, setToDay] = useState('')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function query() {
    if (!providerId.trim() || !fromDay || !toDay || fromDay > toDay) {
      setError('请填写供应商 ID 和有效的日期范围。'); return
    }
    const days = (Date.parse(toDay) - Date.parse(fromDay)) / 86400000
    if (days > 30) { setError('对账日期范围不能超过 31 天。'); return }
    setBusy(true); setError('')
    const params = new URLSearchParams({ provider_id: providerId.trim(),
      from_day: fromDay, to_day: toDay })
    try {
      const response = await fetch(`/api/admin/usage/reconciliation?${params}`, {
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error('账单差异加载失败。')
      const data = await response.json()
      setRows(data.rows ?? [])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '账单差异加载失败。')
    } finally { setBusy(false) }
  }

  return <section className="gateway-project-grants">
    <h3>供应商账单差异</h3>
    <p>按 UTC 日期、供应商和模型核对。供应商账单与 PC 回传分别统计，避免重复计费。</p>
    <form className="gateway-usage-filters" onSubmit={event => { event.preventDefault(); void query() }}>
      <label>对账供应商 ID<input value={providerId} maxLength={64}
        onChange={event => setProviderId(event.target.value)} /></label>
      <label>对账开始日期<input type="date" value={fromDay}
        onChange={event => setFromDay(event.target.value)} /></label>
      <label>对账结束日期<input type="date" value={toDay}
        onChange={event => setToDay(event.target.value)} /></label>
      <button type="submit" disabled={busy}>查看账单差异</button>
    </form>
    {busy && <p role="status"><span className="gateway-spinner" aria-hidden="true" /> 正在核对账单…</p>}
    {error && <p role="alert" className="gateway-auth-error">{error}</p>}
    {rows && !busy && !error && (rows.length ? <ul className="gateway-device-list">{rows.map(row =>
      <li key={`${row.day}-${row.provider_id}-${row.model}`}><div>
        <strong>{row.model ?? '模型未标记'} · {statusNames[row.status] ?? row.status}</strong>
        <p>{row.day} · PC {row.device_event_count} 条 · 账单 {row.provider_line_count} 条 ·
          未完成计量 {row.unmetered_count} 条</p>
        <p>输入差异 {row.input_tokens_difference ?? '不可比较'} ·
          输出差异 {row.output_tokens_difference ?? '不可比较'} ·
          费用差异 {row.cost_difference ?? '不可比较'} {row.currency ?? ''}</p>
        <p>PC 估算 {row.estimated_cost ?? '未知'} {row.currency ?? ''} ·
          账单 {row.billed_cost ?? '未知'} {row.currency ?? ''}</p>
      </div></li>)}</ul> : <p>当前范围内没有可核对的用量。</p>)}
  </section>
}
