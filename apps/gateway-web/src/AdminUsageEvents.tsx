import { useEffect, useState } from 'react'

type UsageEvent = { id: string; request_id: string | null; source: string;
  metering_status: string; occurred_at: string; user_id: string | null;
  initiated_by_user_id: string | null; device_id: string; project_id: string | null;
  task_id: string | null; run_id: string | null; message_id: string | null;
  session_id: string | null; provider_id: string | null; provider_revision: number | null;
  model: string | null; input_tokens: number | null; output_tokens: number | null;
  cache_read_tokens: number | null; cache_write_tokens: number | null;
  total_tokens: number | null; pricing_version: string | null; currency: string | null;
  estimated_cost: string | null }

function value(input: string | number | null) { return input === null ? '未知' : String(input) }
function sourceName(source: string) {
  return source === 'reported_by_device' ? 'PC 回传' : source === 'provider_reconciled'
    ? '供应商对账' : '未知来源'
}

export function AdminUsageEvents({ filters }: { filters: string }) {
  const [events, setEvents] = useState<UsageEvent[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams(filters)
    params.set('page', String(page)); params.set('page_size', '25')
    setLoading(true); setError('')
    void fetch(`/api/admin/usage/events?${params}`, { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('用量明细加载失败。')
        const data = await response.json()
        if (!controller.signal.aborted) { setEvents(data.events ?? []); setTotal(data.total ?? 0) }
      }).catch(reason => {
        if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '用量明细加载失败。')
      }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [filters, page, revision])

  return <section className="gateway-project-grants">
    <h3>计量明细</h3>
    {loading && <p role="status">正在加载用量明细…</p>}
    {error && <p role="alert" className="gateway-auth-error">{error} <button type="button"
      onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {!loading && !error && events.length === 0 && <p>当前条件下没有计量事件。</p>}
    <ul className="gateway-device-list">{events.map(event => <li key={event.id}>
      <div><strong>{event.model ?? '模型未标记'}</strong><p>{sourceName(event.source)} · {
        event.metering_status === 'unmetered' ? '未完成计量' : '已计量'} · {
        new Date(event.occurred_at).toLocaleString()}</p>
        <p>PC {event.device_id} · 供应商 {value(event.provider_id)} · 总 Token {
          value(event.total_tokens)} · 估算成本 {event.estimated_cost ?? '未完成计量'} {
          event.currency ?? ''}</p>
        <details><summary>事件定位与分类</summary>
          <p>用量事件 {event.id} · 请求 {value(event.request_id)} · 用户 {value(event.user_id)} · 原始发起人 {
            value(event.initiated_by_user_id)}</p>
          <p>项目 {value(event.project_id)} · 任务 {value(event.task_id)} · 运行 {value(event.run_id)} · 会话 {
            value(event.session_id)} · 消息 {value(event.message_id)}</p>
          <p>供应商配置版本 {value(event.provider_revision)} · 价格版本 {value(event.pricing_version)}</p>
          <p>输入 {value(event.input_tokens)} · 输出 {value(event.output_tokens)} · 缓存读取 {
            value(event.cache_read_tokens)} · 缓存写入 {value(event.cache_write_tokens)}</p>
        </details></div></li>)}</ul>
    <div className="gateway-admin-pagination"><span>共 {total} 条事件 · 第 {page}/{
      Math.max(1, Math.ceil(total / 25))} 页</span>
      <button type="button" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}>上一页</button>
      <button type="button" disabled={page >= Math.ceil(total / 25) || loading}
        onClick={() => setPage(value => value + 1)}>下一页</button></div>
  </section>
}
