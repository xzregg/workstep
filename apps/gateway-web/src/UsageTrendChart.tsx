import { useState } from 'react'
import { usageCount, type UsageGroup } from './usageStatistics'

export function UsageTrendChart({ rows, field, title }: {
 rows: UsageGroup[]; field: 'total_tokens' | 'event_count'; title: string
}) {
 const [active, setActive] = useState<number | null>(null)
 const maximum = Math.max(1, ...rows.map(row => row[field] ?? 0))
 const first = Date.parse(rows[0]?.value ?? ''), last = Date.parse(rows.at(-1)?.value ?? '')
 const x = (index: number) => rows.length === 1 ? 300 : Number.isFinite(first) && last > first
  ? (Date.parse(rows[index].value ?? '') - first) / (last - first) * 600 : index * 600 / Math.max(1, rows.length - 1)
 const y = (value: number) => 150 - value / maximum * 140
 // Missing measurements break the line instead of being drawn as zero.
 const segments: string[][] = [[]]
 rows.forEach((row, index) => {
  if (row[field] == null) { segments.push([]); return }
  segments.at(-1)!.push(`${x(index)},${y(row[field]!)}`)
 })
 const point = active === null ? null : rows[active]
 return <section className="gateway-usage-chart">
  <h3>{title}</h3>
  <div className="gateway-usage-chart-canvas">
   <svg viewBox="0 0 600 160" role="img" aria-label={title}>
    <title>{title}</title>
    <text x="0" y="8" className="gateway-usage-chart-scale">{usageCount(maximum)}</text>
    <text x="0" y="160" className="gateway-usage-chart-scale">0</text>
    {[0,1,2,3].map(line => <line key={line} x1="0" x2="600" y1={10+line*47} y2={10+line*47} className="gateway-usage-chart-grid"/>)}
    {segments.filter(segment => segment.length > 1).map((segment,index) => <polyline key={index} points={segment.join(' ')} className="gateway-usage-chart-line"/>)}
    {rows.map((row,index) => <g key={row.value ?? index}>
     {row[field] != null && <circle cx={x(index)} cy={y(row[field]!)} r="3" className="gateway-usage-chart-dot"/>}
     <rect x={Math.max(0,x(index)-300/Math.max(1,rows.length))} y="0" width={600/Math.max(1,rows.length)} height="160"
      className="gateway-usage-chart-hit" tabIndex={0} aria-label={`${row.value ?? '未标记'}：${usageCount(row[field])}`}
      onPointerEnter={() => setActive(index)} onPointerLeave={() => setActive(null)} onFocus={() => setActive(index)} onBlur={() => setActive(null)} onClick={() => setActive(index)}>
      <title>{row.value ?? '未标记'}：{usageCount(row[field])}</title>
     </rect>
    </g>)}
   </svg>
   {point && <div className="gateway-usage-chart-tooltip" role="status"><strong>{point.value ?? '未标记'}</strong><span>{usageCount(point[field])}</span></div>}
  </div>
  <div className="gateway-usage-chart-axis"><span>{rows[0]?.value}</span><span>{rows.at(-1)?.value}</span></div>
  <p className="gateway-usage-chart-note">按 UTC 日期统计；未上报的数据保留空缺。</p>
 </section>
}
