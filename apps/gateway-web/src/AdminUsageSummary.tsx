import { useEffect, useState } from 'react'

type Totals = { event_count: number; unmetered_count: number; input_tokens: number | null;
  output_tokens: number | null; cache_read_tokens: number | null;
  cache_write_tokens: number | null; total_tokens: number | null;
  estimated_cost: string | null; billed_cost: string | null; currency: string | null }
type Summary = Totals & { group_by?: string; groups?: Array<Totals & { value: string | null }>;
  group_total?: number }

function count(value: number | null) { return value === null ? '未上报' : value.toLocaleString() }

export function AdminUsageSummary({ filters }: { filters: string }) {
  const providerSource = new URLSearchParams(filters).get('source') === 'provider_reconciled'
  const [groupBy, setGroupBy] = useState('')
  const [page, setPage] = useState(1)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams(filters)
    if (groupBy) {
      params.set('group_by', groupBy); params.set('limit', '25'); params.set('offset', String((page - 1) * 25))
    }
    setLoading(true); setError('')
    void fetch(`/api/admin/usage?${params}`, { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('用量汇总加载失败。')
        const data = await response.json()
        if (!controller.signal.aborted) setSummary(data)
      }).catch(reason => {
        if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '用量汇总加载失败。')
      }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [filters, groupBy, page, revision])

  return <section className="gateway-project-grants">
    <h3>Token 与{providerSource ? '账单金额' : '估算成本'}</h3>
    {loading && <p role="status">正在加载用量汇总…</p>}
    {error && <p role="alert" className="gateway-auth-error">{error} <button type="button"
      onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {summary && !error && <>
      <p>{summary.event_count} 条计量事件 · {summary.unmetered_count} 条未完成计量</p>
      <div className="gateway-usage-totals">
        <p>输入 {count(summary.input_tokens)} · 输出 {count(summary.output_tokens)} · 缓存读取 {
          count(summary.cache_read_tokens)} · 缓存写入 {count(summary.cache_write_tokens)}</p>
        <p>总 Token {count(summary.total_tokens)} · {providerSource ? '账单金额' : '估算成本'} {
          (providerSource ? summary.billed_cost : summary.estimated_cost) ?? '暂不可汇总'} {summary.currency && summary.currency !== 'mixed'
          ? summary.currency : ''}{summary.currency === 'mixed' ? '（存在多种币种）' : ''}</p>
      </div>
      <p>计量来源见明细；PC 回传用量与供应商账单对账是不同来源。</p>
    </>}
    <label htmlFor="usage-group-by">分组维度</label>
    <select id="usage-group-by" value={groupBy} onChange={event => {
      setGroupBy(event.target.value); setPage(1)
    }}><option value="">不分组</option><option value="day">日期</option>
      <option value="user">用户</option><option value="device">PC</option>
      <option value="project">项目</option><option value="provider">供应商</option>
      <option value="model">模型</option></select>
    {groupBy && summary && <>
      <ul className="gateway-device-list">{(summary.groups ?? []).map((group, index) =>
        <li key={`${group.value ?? 'unknown'}-${index}`}><div><strong>{group.value ?? '未标记'}</strong>
          <p>{group.event_count} 条 · {group.unmetered_count} 条未完成计量 · 总 Token {
            count(group.total_tokens)} · {providerSource ? '账单金额' : '估算成本'} {
            (providerSource ? group.billed_cost : group.estimated_cost) ?? '暂不可汇总'} {
            group.currency && group.currency !== 'mixed' ? group.currency : ''}</p></div></li>)}</ul>
      <div className="gateway-admin-pagination"><span>共 {summary.group_total ?? 0} 组 · 第 {page}/{
        Math.max(1, Math.ceil((summary.group_total ?? 0) / 25))} 页</span>
        <button type="button" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}>上一页</button>
        <button type="button" disabled={page >= Math.ceil((summary.group_total ?? 0) / 25) || loading}
          onClick={() => setPage(value => value + 1)}>下一页</button></div>
    </>}
  </section>
}
