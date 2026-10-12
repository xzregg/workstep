import { useEffect, useState } from 'react'
import { AdminRecordTable } from './AdminRecordTable'
import { LedgerExportButton } from './LedgerExportButton'
import { UsageMetricStrip } from './UsageMetricStrip'
import { UsageOverviewCharts } from './UsageOverviewCharts'
import { UsageDistributionChart } from './UsageDistributionChart'
import { usageCount, usageCost, usageDimensions, usageGroupName, usageCacheRate, type UsageDimension, type UsageSummary } from './usageStatistics'

export function AdminUsageSummary({ filters, groupBy = 'day', overview = false, onDetails }: {
 filters: string; groupBy?: UsageDimension; overview?: boolean; onDetails?: (field: string, value: string) => void
}) {
 const billed = new URLSearchParams(filters).get('source') === 'provider_reconciled'
 const costLabel = billed ? '账单金额' : '估算成本'
 const countLabel = billed ? '账单行数' : '调用次数'
 const [page, setPage] = useState(1)
 const [summary, setSummary] = useState<UsageSummary | null>(null)
 const [loading, setLoading] = useState(true)
 const [error, setError] = useState('')
 const [revision, setRevision] = useState(0)
 const pageSize = 25
 const effectiveGroup = overview ? 'user' : groupBy
 useEffect(() => {
  const controller = new AbortController()
  const params = new URLSearchParams(filters)
  params.set('group_by', effectiveGroup); params.set('limit', String(pageSize)); params.set('offset', String((page - 1) * pageSize))
  setLoading(true); setError('')
  void fetch(`/api/admin/usage?${params}`, { credentials: 'same-origin', signal: controller.signal })
   .then(async response => {
    if (!response.ok) throw new Error('用量汇总加载失败。')
    const data = await response.json()
    if (!controller.signal.aborted) setSummary(data)
   }).catch(reason => {
    if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '用量汇总加载失败。')
   }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
  return () => controller.abort()
 }, [filters, effectiveGroup, page, pageSize, revision])
 const groups = summary?.groups ?? []
 const dimension = usageDimensions[effectiveGroup]
 const pages = Math.max(1, Math.ceil((summary?.group_total ?? 0) / pageSize))
 return <section className="gateway-usage-report" aria-label={overview ? '用量总览' : dimension.label+'统计'}>
  {loading && <p role="status"><span className="gateway-spinner" aria-hidden="true"/> 正在加载用量汇总…</p>}
  {error && <p role="alert" className="gateway-auth-error">{error} <button type="button" onClick={() => setRevision(value => value + 1)}>重试</button></p>}
  {summary && !error && !loading && <>
   <p>{summary.event_count} 条计量事件 · {summary.unmetered_count} 条未完成计量</p>
   <UsageMetricStrip summary={summary} filters={filters} overview={overview}/>
   {summary.unmetered_count > 0 && <p className="gateway-usage-measurement-note">部分调用未完成计量，Token 和成本仅汇总已上报值。</p>}
   {summary.event_count === 0 ? <p>当前条件下没有计量事件。</p> : <>
    {overview ? <UsageOverviewCharts filters={filters}/> : effectiveGroup !== 'day' && <UsageDistributionChart rows={groups} dimension={effectiveGroup} bars/>}
    <h3>{dimension.label}用量分布{effectiveGroup === 'day' ? '（UTC）' : ''}</h3>
    <AdminRecordTable columns={[dimension.label,countLabel,'未完成计量','输入 Token','输出 Token','缓存读取','缓存写入','缓存率','总 Token',costLabel, ...(dimension.filter ? ['操作'] : [])]}>
     {groups.map((row,index) => <tr key={row.value ?? index}>
      <td><strong>{usageGroupName(row,effectiveGroup)}</strong>{effectiveGroup !== 'day' && effectiveGroup !== 'model' && row.value && <small className="gateway-usage-group-id" title={row.value}>{row.value}</small>}</td><td>{usageCount(row.event_count)}</td><td>{usageCount(row.unmetered_count)}</td>
      <td>{usageCount(row.input_tokens)}</td><td>{usageCount(row.output_tokens)}</td><td>{usageCount(row.cache_read_tokens)}</td><td>{usageCount(row.cache_write_tokens)}</td>
      <td>{usageCacheRate(row) === null ? '不可计算' : (usageCacheRate(row)!*100).toFixed(1)+'%'}</td><td>{usageCount(row.total_tokens)}</td><td>{usageCost(row,billed)}</td>
      {dimension.filter && <td><button type="button" disabled={row.value === null} onClick={() => onDetails?.(dimension.filter!,row.value!)}>查看明细</button></td>}
     </tr>)}
    </AdminRecordTable>
    {groups.length === 0 && <p>当前范围没有分组数据。</p>}
   </>}
   { <div className="gateway-admin-pagination"><span>共 {summary.group_total ?? 0} 组 · 第 {page}/{pages} 页</span>
    <LedgerExportButton rows={groups} filename={`usage-${groupBy}-page-${page}.csv`} columns={[
     {name:dimension.label+'名称',key:'label'}, {name:dimension.label+' ID',key:'value'}, {name:countLabel,key:'event_count'}, {name:'未完成计量',key:'unmetered_count'},
     {name:'输入 Token',key:'input_tokens'}, {name:'输出 Token',key:'output_tokens'}, {name:'缓存读取',key:'cache_read_tokens'},
     {name:'缓存写入',key:'cache_write_tokens'}, {name:'总 Token',key:'total_tokens'}, {name:'币种',key:'currency'},
     {name:costLabel,key:billed?'billed_cost':'estimated_cost'},
    ]}/>
    <button type="button" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button>
    <button type="button" disabled={page >= pages} onClick={() => setPage(value => value + 1)}>下一页</button>
   </div>}
  </>}
 </section>
}
