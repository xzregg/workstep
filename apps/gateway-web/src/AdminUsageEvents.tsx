import { Fragment, useEffect, useState } from 'react'
import { AdminRecordTable } from './AdminRecordTable'
import { usageCount, usageIdentityName } from './usageStatistics'
import { LedgerExportButton } from './LedgerExportButton'

type UsageEvent = { user_name?: string | null; project_name?: string | null; device_name?: string | null; provider_name?: string | null; id: string; request_id: string | null; source: string;
  metering_status: string; occurred_at: string; user_id: string | null;
  initiated_by_user_id: string | null; device_id: string; project_id: string | null;
  task_id: string | null; run_id: string | null; message_id: string | null;
  session_id: string | null; provider_id: string | null; provider_revision: number | null;
  model: string | null; input_tokens: number | null; output_tokens: number | null;
  cache_read_tokens: number | null; cache_write_tokens: number | null;
  total_tokens: number | null; pricing_version: string | null; currency: string | null;
  estimated_cost: string | null; billed_cost: string | null }

function value(input: string | number | null) { return input === null ? '未知' : String(input) }
function sourceName(source: string) {
  return source === 'reported_by_device' ? 'PC 回传' : source === 'provider_reconciled'
    ? '供应商对账' : '未知来源'
}

export function AdminUsageEvents({ filters }: { filters: string }) {
  const [events, setEvents] = useState<UsageEvent[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams(filters)
    params.set('page', String(page)); params.set('page_size', '25')
    setLoading(true); setError(''); setExpandedId(null)
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

  return <section className="gateway-usage-events">
    <h3>计量明细</h3>
    {loading && <p role="status"><span className="gateway-spinner" aria-hidden="true"/> 正在加载用量明细…</p>}
    {error && <p role="alert" className="gateway-auth-error">{error} <button type="button"
      onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {!loading && !error && events.length === 0 && <p>当前条件下没有计量事件。</p>}
    {!loading && !error && events.length > 0 && <AdminRecordTable columns={['发生时间','模型','用户','项目','设备','计量来源','输入 Token','输出 Token','缓存读取','缓存写入','总 Token','Token 计量','金额','操作']}>
      {events.map(event => <Fragment key={event.id}>
        <tr>
          <td>{new Date(event.occurred_at).toLocaleString('zh-CN')}</td>
          <td><strong>{event.model ?? '模型未标记'}</strong></td>
          <td title={event.user_id ?? undefined}>{usageIdentityName(event.user_name,event.user_id,'user')}</td>
          <td title={event.project_id ?? undefined}>{usageIdentityName(event.project_name,event.project_id,'project')}</td>
          <td title={event.device_id}>{event.source === 'provider_reconciled' ? '—' : usageIdentityName(event.device_name,event.device_id,'device')}</td>
          <td>{sourceName(event.source)}</td>
          <td>{usageCount(event.input_tokens)}</td><td>{usageCount(event.output_tokens)}</td>
          <td>{usageCount(event.cache_read_tokens)}</td><td>{usageCount(event.cache_write_tokens)}</td>
          <td><strong>{usageCount(event.total_tokens)}</strong></td>
          <td><span className="gateway-usage-metering" data-metered={event.metering_status === 'metered'}>{event.metering_status === 'unmetered' ? '未完成计量' : '已计量'}</span></td>
          <td>{(event.source === 'provider_reconciled' ? event.billed_cost : event.estimated_cost) == null ? '待计价' : <>{event.source === 'provider_reconciled' ? event.billed_cost : event.estimated_cost} {event.currency ?? ''}</>}
            <small className="gateway-usage-money-source">{event.source === 'provider_reconciled' ? '账单金额' : '估算成本'}</small></td>
          <td><button type="button" aria-label={`查看事件 ${event.id}`} aria-expanded={expandedId === event.id} aria-controls={`usage-event-${event.id}`} onClick={() => setExpandedId(current => current === event.id ? null : event.id)}>{expandedId === event.id ? '收起' : '详情'}</button></td>
        </tr>
        {expandedId === event.id && <tr className="gateway-usage-event-detail"><td colSpan={14}>
          <dl id={`usage-event-${event.id}`} className="gateway-usage-event-location">
            {[
              ['事件 ID',event.id],['请求 ID',event.request_id],['用户 ID',event.user_id],['原始发起人 ID',event.initiated_by_user_id],
              ['设备 ID',event.device_id],['项目 ID',event.project_id],['任务 ID',event.task_id],['运行 ID',event.run_id],
              ['会话 ID',event.session_id],['消息 ID',event.message_id],['供应商 ID',event.provider_id],
              ['供应商',usageIdentityName(event.provider_name,event.provider_id,'provider')],['供应商配置版本',event.provider_revision],['价格版本',event.pricing_version],
            ].map(([label,input]) => <div key={String(label)}><dt>{label}</dt><dd>{value(input ?? null)}</dd></div>)}
          </dl>
        </td></tr>}
      </Fragment>)}
    </AdminRecordTable>}
    <div className="gateway-admin-pagination"><span>共 {total} 条事件 · 第 {page}/{
      Math.max(1, Math.ceil(total / 25))} 页</span>
      <LedgerExportButton rows={events} filename={`usage-page-${page}.csv`} disabled={loading || !!error}
        columns={[{ name: '事件 ID', key: 'id' }, { name: '时间', key: 'occurred_at' },
          { name: '来源', key: 'source' }, { name: '计量状态', key: 'metering_status' },
          { name: '用户名', key: 'user_name' }, { name: '项目名', key: 'project_name' },
          { name: '设备名', key: 'device_name' }, { name: '供应商名', key: 'provider_name' },
          { name: '用户 ID', key: 'user_id' }, { name: '发起人 ID', key: 'initiated_by_user_id' },
          { name: '设备 ID', key: 'device_id' }, { name: '项目 ID', key: 'project_id' },
          { name: '供应商 ID', key: 'provider_id' }, { name: '模型', key: 'model' },
          { name: '输入 Token', key: 'input_tokens' }, { name: '输出 Token', key: 'output_tokens' },
          { name: '缓存读取', key: 'cache_read_tokens' }, { name: '缓存写入', key: 'cache_write_tokens' },
          { name: '总 Token', key: 'total_tokens' }, { name: '币种', key: 'currency' },
          { name: '估算成本', key: 'estimated_cost' }, { name: '账单金额', key: 'billed_cost' }]} />
      <button type="button" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}>上一页</button>
      <button type="button" disabled={page >= Math.ceil(total / 25) || loading}
        onClick={() => setPage(value => value + 1)}>下一页</button></div>
  </section>
}
