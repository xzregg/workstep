import { useCallback, useMemo, useState } from 'react'
import type { SystemStatisticsReport, SystemTrendPoint } from '../api/systemStatistics'
import { useI18n } from '../i18n'

export default function SystemResourceTrend({ report, descriptorLabel }: { report: SystemStatisticsReport; descriptorLabel: string }) {
  const { t, locale } = useI18n()
  const [metric, setMetric] = useState<'cpu' | 'memory' | 'descriptors'>('cpu')
  const [active, setActive] = useState<number | null>(null)
  const memory = metric === 'memory', descriptors = metric === 'descriptors'
  const title = descriptors ? descriptorLabel : memory ? t('systemStatistics.memory') : 'CPU'
  const firstLabel = descriptors ? t('systemStatistics.workstepTotal') : t('systemStatistics.host')
  const secondLabel = descriptors ? t('systemStatistics.daemon') : 'WorkStep'
  const keyA: keyof SystemTrendPoint = descriptors ? 'total_descriptors' : memory ? 'host_memory_used' : 'host_cpu_percent'
  const keyB: keyof SystemTrendPoint = descriptors ? 'daemon_descriptors' : memory ? 'total_memory_rss' : 'total_cpu_percent'
  const data = report.history
  const end = data.length ? Date.parse(data[data.length - 1].sampled_at) : Date.now()
  const start = end - report.retention_seconds * 1000
  const value = useCallback((point: SystemTrendPoint, key: keyof SystemTrendPoint): number | null => {
    const raw = point[key]
    return typeof raw === 'number' ? raw / (memory ? 1024 ** 3 : 1) : null
  }, [memory])
  const maximum = useMemo(() => {
    const values = data.flatMap(p => [value(p, keyA), value(p, keyB)]).filter((v): v is number => v !== null)
    const highest = Math.max(...values, memory ? (report.sample?.host.memory_total || 0) / 1024 ** 3 : descriptors ? 10 : 60)
    return memory ? Math.max(1, Math.ceil(highest)) : descriptors ? Math.ceil(highest / 100) * 100 : Math.min(100, Math.ceil(highest / 20) * 20)
    // Only metric keys and fresh samples change the scale.
  }, [data, keyA, keyB, memory, descriptors, report.sample?.host.memory_total, value])
  const x = (point: SystemTrendPoint) => 38 + Math.max(0, Math.min(1, (Date.parse(point.sampled_at) - start) / (end - start))) * 618
  const y = (v: number) => 154 - v / maximum * 140
  const paths = (key: keyof SystemTrendPoint) => {
    const segments: string[][] = []; let current: string[] = []
    data.forEach(point => {
      const v = value(point, key)
      if (v === null) { if (current.length) segments.push(current); current = [] }
      else current.push(`${x(point)},${y(v)}`)
    })
    if (current.length) segments.push(current)
    return segments
  }
  const number = (v: number | null) => v === null ? t('systemStatistics.unavailable') : new Intl.NumberFormat(locale, { maximumFractionDigits: descriptors ? 0 : 1 }).format(v) + (memory ? ' GB' : descriptors ? '' : '%')
  const selected = active !== null ? data[active] : undefined
  const accessibleText = selected ? `${new Date(selected.sampled_at).toLocaleTimeString(locale)} · ${firstLabel} ${number(value(selected, keyA))} · ${secondLabel} ${number(value(selected, keyB))}` : title
  return <section className="system-card system-trend">
    <div className="system-panel-head"><h2>{t('systemStatistics.trend')} <small>{t('systemStatistics.recentMinutes', { minutes: report.retention_seconds / 60 })}</small></h2>
      <div className="system-segmented" aria-label={t('systemStatistics.trendMetric')}>
        {(['cpu', 'memory', 'descriptors'] as const).map(key => <button key={key} aria-pressed={metric === key} onClick={() => { setMetric(key); setActive(null) }}>{key === 'cpu' ? 'CPU' : key === 'memory' ? t('systemStatistics.memory') : descriptorLabel}</button>)}
      </div>
    </div>
    <div className="system-legend"><span><i />{firstLabel}</span><span><i className="system-purple" />{secondLabel}</span></div>
    <div className="system-chart-wrap">
      <svg className="system-chart" viewBox="0 0 680 180" role="img" tabIndex={0} aria-label={`${t('systemStatistics.recentMinutes', { minutes: report.retention_seconds / 60 })} ${title}`} aria-describedby="system-trend-description"
        onFocus={() => setActive(data.length ? data.length - 1 : null)} onBlur={() => setActive(null)}
        onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setActive(index => Math.max(0, Math.min(data.length - 1, (index ?? data.length - 1) + (event.key === 'ArrowLeft' ? -1 : 1)))) } }}
        onPointerLeave={() => setActive(null)} onPointerMove={event => {
          if (!data.length) return
          const rect = event.currentTarget.getBoundingClientRect(), cursor = (event.clientX - rect.left) / rect.width * 680
          let nearest = 0
          data.forEach((point, index) => { if (Math.abs(x(point) - cursor) < Math.abs(x(data[nearest]) - cursor)) nearest = index })
          setActive(nearest)
        }}>
        {[0, 1, 2, 3].map(i => <g key={i}><line className="system-chart-grid" x1="38" x2="656" y1={y(maximum * i / 3)} y2={y(maximum * i / 3)} /><text x="29" y={y(maximum * i / 3) + 3} textAnchor="end">{new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(maximum * i / 3)}</text></g>)}
        {[keyA, keyB].map((key, index) => paths(key).map((segment, i) => <g key={`${key}-${i}`}>
          {index === 0 && segment.length > 1 && <polygon className="system-chart-area" points={`${segment[0].split(',')[0]},154 ${segment.join(' ')} ${segment.at(-1)!.split(',')[0]},154`} />}
          {segment.length > 1 ? <polyline className={index === 0 ? 'system-chart-line' : 'system-chart-line system-purple-line'} points={segment.join(' ')} /> : <circle cx={segment[0].split(',')[0]} cy={segment[0].split(',')[1]} r="2.5" className={index === 0 ? 'system-chart-dot' : 'system-chart-dot system-purple-dot'} />}
        </g>))}
        {selected && <line className="system-chart-guide" x1={x(selected)} x2={x(selected)} y1="9" y2="154" />}
      </svg>
      {selected && <div className="system-chart-tooltip" style={{ left: `${Math.max(2, Math.min(65, x(selected) / 680 * 100))}%` }}><strong>{new Date(selected.sampled_at).toLocaleTimeString(locale)}</strong><span>{firstLabel} {number(value(selected, keyA))}</span><span>{secondLabel} {number(value(selected, keyB))}</span></div>}
      {!data.length && <span className="system-chart-empty">{t('systemStatistics.collecting')}</span>}
    </div>
    <div id="system-trend-description" className="system-sr-only" aria-live="polite">{accessibleText}</div>
    <div className="system-chart-axis">{[30, 20, 10, 0].map(minutes => <span key={minutes}>{minutes ? t('systemStatistics.minutesAgo', { minutes }) : t('systemStatistics.now')}</span>)}</div>
    <div className="system-chart-caption">{t(descriptors ? 'systemStatistics.descriptorChartHelp' : memory ? 'systemStatistics.memoryChartHelp' : 'systemStatistics.cpuChartHelp')}</div>
  </section>
}
