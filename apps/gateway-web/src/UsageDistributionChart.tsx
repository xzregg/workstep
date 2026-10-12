import { usageCompact, usageGroupName, type UsageDimension, type UsageGroup } from './usageStatistics'
export function UsageDistributionChart({ rows, dimension = 'model', bars = false }: { rows: UsageGroup[]; dimension?: UsageDimension; bars?: boolean }) {
 const measured = rows.filter(row => row.total_tokens != null && row.total_tokens > 0).sort((a,b) => b.total_tokens! - a.total_tokens!)
 const total = measured.reduce((sum,row) => sum + row.total_tokens!, 0)
 const top = measured.slice(0,5)
 const remainder = measured.slice(5).reduce((sum,row) => sum + row.total_tokens!,0)
 const parts = remainder ? [...top, {value:'其他',total_tokens:remainder} as UsageGroup] : top
 const barMaximum = Math.max(1, ...parts.map(row => row.total_tokens ?? 0))
 const title = bars ? '本页用量对比' : '模型用量占比'
 let offset = 0
 return <section className="gateway-usage-chart gateway-usage-distribution">
  <h3>{title}</h3>
  {!bars && <div className="gateway-usage-donut-wrap"><svg viewBox="0 0 120 120" role="img" aria-label={title} className="gateway-usage-donut">
   <circle cx="60" cy="60" r="45" className="gateway-usage-donut-track"/>
   {parts.map((row,index) => {const length=row.total_tokens!/total*282.743;const start=offset;offset+=length;return <circle key={row.value ?? index} cx="60" cy="60" r="45" className="gateway-usage-donut-part" data-color={index} strokeDasharray={`${length} ${282.743-length}`} strokeDashoffset={-start}><title>{usageGroupName(row,dimension)}：{usageCompact(row.total_tokens)}（{(row.total_tokens!/total*100).toFixed(1)}%）</title></circle>})}
  </svg><span className="gateway-usage-donut-total">{usageCompact(total)}<small>已上报 Token</small></span></div>}
  <div className="gateway-usage-distribution-rows">{parts.map((row,index) => <div key={row.value ?? index}>
   <span className="gateway-usage-distribution-name" title={usageGroupName(row,dimension)}><i data-color={index}/>{usageGroupName(row,dimension)}</span><b>{bars ? usageCompact(row.total_tokens) : (row.total_tokens!/total*100).toFixed(1)+'%'}</b>
   {bars && <progress max={barMaximum} value={row.total_tokens ?? 0} aria-label={usageGroupName(row,dimension)+' Token 用量'}/>}
  </div>)}</div>
  {total === 0 && <p className="gateway-usage-chart-note">暂无已上报的 Token 用量。</p>}
  <p className="gateway-usage-chart-note">{bars ? '仅比较当前页，缺失数据不计为零。' : '按已加载模型的已上报 Token 计算占比。'}</p>
 </section>
}
