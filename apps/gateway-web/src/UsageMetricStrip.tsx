import { useUsageComparisons } from './useUsageComparisons'
import { usageCacheRate, usageChange, usageCompact, usageCount, usageCost, usageTokenTotal, type UsageTotals } from './usageStatistics'
export function UsageMetricStrip({ summary, filters, overview }: { summary: UsageTotals; filters: string; overview: boolean }) {
 const comparisons = useUsageComparisons(filters, overview)
 const billed = new URLSearchParams(filters).get('source') === 'provider_reconciled'
 const current = usageTokenTotal(summary), rate = usageCacheRate(summary)
 const change = (key: 'previous' | 'year') => comparisons.loading ? '加载中…' : !comparisons.ranges[key] ? '区间不可比较' : !comparisons.values[key] ? '加载失败' : usageChange(current,usageTokenTotal(comparisons.values[key]!))
 const cells = [
  {label:'总 Token',value:usageCompact(current),hint:overview ? <><span>环比 {change('previous')}</span><span>同比 {change('year')}</span></> : '输入 '+usageCompact(summary.input_tokens)+' · 输出 '+usageCompact(summary.output_tokens)},
  {label:'缓存率',value:rate === null ? '不可计算' : (rate*100).toFixed(1)+'%',hint:'缓存读取 / 输入 Token'},
  {label:billed?'账单行数':'调用次数',value:usageCount(summary.event_count),hint:summary.unmetered_count+' 次未完成计量'},
  {label:'缓存读取',value:usageCompact(summary.cache_read_tokens),hint:'写入 '+usageCompact(summary.cache_write_tokens)},
  ...(overview ? [{label:'上月 Token',value:comparisons.loading ? '加载中…' : usageCompact(usageTokenTotal(comparisons.values.month ?? null)),hint:comparisons.ranges.month.from.slice(0,7)+' · 完整自然月（UTC）'},
   {label:billed?'账单金额':'估算成本',value:usageCost(summary,billed),hint:'缺失金额保留未知'}] : [
   {label:'输入 Token',value:usageCompact(summary.input_tokens),hint:'当前查询范围'}, {label:'输出 Token',value:usageCompact(summary.output_tokens),hint:'当前查询范围'},
  ]),
 ]
 return <>
  <div className="gateway-usage-metrics">{cells.map(cell => <div className="gateway-usage-metric" key={cell.label}><span>{cell.label}</span><strong>{cell.value}</strong><small>{cell.hint}</small></div>)}</div>
  {overview && Object.values(comparisons.values).some(row => row && row.unmetered_count > 0) && <p className="gateway-usage-measurement-note">同期对比含未完成计量，增减仅基于已上报 Token。</p>}
  {overview && comparisons.loading && <p role="status" className="gateway-usage-comparison-status"><span className="gateway-spinner" aria-hidden="true"/> 正在加载同期用量…</p>}
  {overview && comparisons.failed && <p role="alert">部分对比用量加载失败。<button type="button" onClick={comparisons.retry}>重试对比</button></p>}
  {overview && <details className="gateway-usage-comparison-details"><summary>查看对比口径与完整用量</summary><p>环比：前一个等长区间；同比：去年同期；上月：上个完整 UTC 自然月。增减基于已上报 Token，未计量不补零。缓存率是缓存读取占输入的比例，读取大于输入时不计算。</p>
   <div className="gateway-admin-table-scroll"><table className="gateway-admin-table"><thead><tr><th>统计区间</th><th>开始（UTC，含）</th><th>结束（UTC，不含）</th><th>总 Token</th></tr></thead><tbody>
    <tr><td>当前区间</td><td>{new URLSearchParams(filters).get('from_time') ?? '不限'}</td><td>{new URLSearchParams(filters).get('to_time') ?? '不限'}</td><td>{usageCount(current)}</td></tr>
    {(['previous','year','month'] as const).map(key => <tr key={key}><td>{{previous:'环比基期',year:'同比基期',month:'上月'}[key]}</td><td>{comparisons.ranges[key]?.from ?? '未指定'}</td><td>{comparisons.ranges[key]?.to ?? '未指定'}</td><td>{usageCount(usageTokenTotal(comparisons.values[key] ?? null))}</td></tr>)}
   </tbody></table></div>
  </details>}
 </>
}
