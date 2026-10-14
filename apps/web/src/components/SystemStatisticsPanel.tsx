import type { ReactNode } from 'react'
import Icon from './Icon'
import SystemResourceTrend from './SystemResourceTrend'
import { useSystemStatistics } from '../hooks/useSystemStatistics'
import { useI18n } from '../i18n'
import './SystemStatisticsPanel.css'

function HostCard({ label, badge, value, percentage, children, network = false }: {
  label: string; badge?: ReactNode; value: ReactNode; percentage?: number | null; children: ReactNode; network?: boolean
}) {
  return <div className={`system-card system-host-card${network ? ' system-host-card--network' : ''}`}>
    <div className="system-metric-label"><span>{label}</span><span>{badge}</span></div>
    <div className="system-value">{value}</div>
    {percentage !== undefined && <div className="system-meter"><span style={{ width: `${Math.max(0, Math.min(100, percentage || 0))}%` }} /></div>}
    <div className="system-card-foot">{children}</div>
  </div>
}
function StripItem({ label, value, children, warning }: { label: string; value: ReactNode; children: ReactNode; warning?: boolean }) {
  return <div className="system-strip-item"><div className="system-strip-label">{label}</div><div className="system-strip-value" data-warning={warning || undefined}>{value}</div><div className="system-strip-hint">{children}</div></div>
}

export default function SystemStatisticsPanel() {
  const { t, locale } = useI18n()
  const { report, loading, failed, paused, refresh, togglePaused } = useSystemStatistics()
  const sample = report?.sample
  const unavailable = t('systemStatistics.unavailable')
  const numeric = (value: number | null | undefined, digits = 0) => value === null || value === undefined ? unavailable : new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
  const percent = (value: number | null | undefined) => value == null ? unavailable : `${numeric(value, 1)}%`
  const bytes = (value: number | null | undefined) => {
    if (value == null) return unavailable
    const unit = value >= 1024 ** 3 ? 'GB' : value >= 1024 ** 2 ? 'MB' : value >= 1024 ? 'KB' : 'B'
    const divisor = unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : unit === 'KB' ? 1024 : 1
    return `${numeric(value / divisor, divisor === 1 ? 0 : 1)} ${unit}`
  }
  const amount = (used: number | null, total: number | null) => {
    if (used === null || total === null) return unavailable
    const divisor = total >= 1024 ** 3 ? 1024 ** 3 : 1024 ** 2, unit = divisor === 1024 ** 3 ? 'GB' : 'MB'
    return <>{numeric(used / divisor, 1)}<small>/ {numeric(total / divisor, 0)} {unit}</small></>
  }
  const stale = failed || report?.status === 'error'
  const warming = !sample && !stale
  const descriptors = sample?.descriptor_kind === 'handles' ? t('systemStatistics.handles') : t('systemStatistics.descriptors')
  const limit = sample?.daemon.descriptor_limit
  const descriptorUsage = limit != null && limit > 0 && sample?.daemon.descriptors != null ? sample.daemon.descriptors / limit * 100 : null
  const warning = descriptorUsage !== null && descriptorUsage >= 80
  const uptime = sample?.daemon.uptime_seconds
  const runtime = uptime == null ? unavailable : uptime >= 86400 ? <>{Math.floor(uptime / 86400)}<small>{t('datetime.day')}</small> {Math.floor(uptime % 86400 / 3600)}<small>{t('datetime.hour')}</small></> : uptime >= 3600 ? <>{Math.floor(uptime / 3600)}<small>{t('datetime.hour')}</small> {Math.floor(uptime % 3600 / 60)}<small>{t('datetime.minute')}</small></> : <>{Math.floor(uptime / 60)}<small>{t('datetime.minute')}</small></>
  const statusLabel = stale ? t('systemStatistics.stale') : warming ? t('systemStatistics.collecting') : paused ? t('systemStatistics.paused') : t('systemStatistics.live')
  return <div className="system-statistics">
    <div className="system-toolbar">
      <div className="system-row"><span className="system-live" data-state={stale ? 'error' : paused ? 'paused' : 'live'}>{warming ? <span className="task-status-spinner" /> : <i />}{statusLabel}</span><span className="system-sampling-note">{t('systemStatistics.samplingNote', { seconds: report?.interval_seconds || 5, minutes: (report?.retention_seconds || 1800) / 60 })}</span></div>
      <div className="system-row"><span className="system-updated">{sample && t('systemStatistics.updatedAt', { time: new Date(sample.sampled_at).toLocaleTimeString(locale, { hour12: false }) })}</span><button className="system-button" onClick={togglePaused}>{t(paused ? 'systemStatistics.resume' : 'systemStatistics.pause')}</button><button className="system-button system-button-icon" onClick={() => void refresh()} disabled={loading}><Icon name="refresh" size={14} className={loading ? 'system-spinning' : undefined} />{t('common.refresh')}</button></div>
    </div>
    {stale && <div className="system-banner" role="status"><span>{t(sample ? 'systemStatistics.staleHelp' : 'systemStatistics.loadFailed')}</span><button className="system-button" disabled={loading} onClick={() => void refresh()}>{t('common.retry')}</button></div>}
    {warning && <div className="system-banner" role="status">{t('systemStatistics.descriptorWarning', { rate: numeric(descriptorUsage, 1), used: numeric(sample?.daemon.descriptors), limit: numeric(limit) })}</div>}
    {sample?.partial && <div className="system-banner system-banner--neutral" role="status">{t('systemStatistics.partial')}</div>}
    {!sample ? <div className="system-empty">{loading || warming ? <><span className="task-status-spinner" />{t('systemStatistics.collecting')}</> : t('systemStatistics.loadFailed')}</div> : <>
      <div className="system-section-heading"><h2>{t('systemStatistics.hostResources')}</h2><small>{t('systemStatistics.deviceInfo', { platform: sample.platform === 'Darwin' ? 'macOS' : sample.platform, cores: sample.host.cpu_count })}</small></div>
      <div className="system-host-grid">
        <HostCard label={t('systemStatistics.cpuUsage')} badge={<Icon name="monitor" size={15} />} value={sample.host.cpu_percent === null ? <span className="system-unavailable">{report?.history.length === 1 ? t('systemStatistics.collecting') : unavailable}</span> : <>{numeric(sample.host.cpu_percent, 1)}<small>%</small></>} percentage={sample.host.cpu_percent}>
          <span>{t('systemStatistics.workstepUsage')} <b>{percent(sample.total.cpu_percent)}</b></span><span>{t('systemStatistics.hostBasis')}</span>
        </HostCard>
        <HostCard label={t('systemStatistics.memoryUsage')} badge={percent(sample.host.memory_percent)} value={amount(sample.host.memory_used, sample.host.memory_total)} percentage={sample.host.memory_percent}>
          <span>{t('systemStatistics.available')} {bytes(sample.host.memory_available)}</span><span>{t('systemStatistics.swap')} {bytes(sample.host.swap_used)}</span>
        </HostCard>
        <HostCard label={t('systemStatistics.diskUsage')} badge={percent(sample.host.disk_percent)} value={amount(sample.host.disk_used, sample.host.disk_total)} percentage={sample.host.disk_percent}>
          <span>{t('systemStatistics.available')} {bytes(sample.host.disk_free)}</span><span>{t('systemStatistics.configDisk')}</span>
        </HostCard>
        <HostCard label={t('systemStatistics.networkRate')} badge={t('systemStatistics.host')} network value={<div className="system-network-values"><div><em>↓ {t('systemStatistics.receive')}</em><span>{sample.host.network_recv_per_second == null ? unavailable : bytes(sample.host.network_recv_per_second)}<small>{sample.host.network_recv_per_second != null && '/s'}</small></span></div><div><em>↑ {t('systemStatistics.send')}</em><span>{sample.host.network_sent_per_second == null ? unavailable : bytes(sample.host.network_sent_per_second)}<small>{sample.host.network_sent_per_second != null && '/s'}</small></span></div></div>}>
          <span>{t('systemStatistics.networkHelp')}</span>
        </HostCard>
      </div>
      <div className="system-section-heading"><h2>{t('systemStatistics.runtime')}</h2><small>{t('systemStatistics.runtimeScope')}</small></div>
      <div className="system-card system-runtime-strip">
        <StripItem label={t('systemStatistics.cpuOccupation')} value={percent(sample.total.cpu_percent)}>{t('systemStatistics.normalizedCpu')}</StripItem>
        <StripItem label={t('systemStatistics.residentMemory')} value={bytes(sample.total.memory_rss)}>{t('systemStatistics.memoryBreakdown', { daemon: bytes(sample.daemon.memory_rss), children: bytes(sample.children_summary.memory_rss) })}</StripItem>
        <StripItem label={descriptors} value={numeric(sample.total.descriptors)} warning={warning}>{t('systemStatistics.daemon')} {numeric(sample.daemon.descriptors)}{limit != null && <> / {numeric(limit)} {t('systemStatistics.limit')}</>}</StripItem>
        <StripItem label={t('systemStatistics.childrenThreads')} value={<>{numeric(sample.children_summary.process_count)}<small>{t('systemStatistics.processUnit')} / {numeric(sample.total.threads)} {t('systemStatistics.threadUnit')}</small></>}>{t('systemStatistics.threadsHelp')}</StripItem>
        <StripItem label={t('systemStatistics.uptime')} value={runtime}>{t('systemStatistics.daemon')} PID <span className="system-mono">{sample.daemon.pid}</span></StripItem>
      </div>
      <div className="system-mid-grid">
        <SystemResourceTrend report={report!} descriptorLabel={descriptors} />
        <section className="system-card system-health"><div className="system-panel-head"><h2>{t('systemStatistics.daemonStatus')}</h2><span className="system-badge">{t('systemStatistics.local')}</span></div><div className="system-health-body">
          <div className="system-health-title" data-state={stale ? 'error' : 'ok'}><Icon name={stale ? 'clock' : 'check'} size={19} />{t(stale ? 'systemStatistics.samplingInterrupted' : 'systemStatistics.samplingOk')}</div>
          <p>{t(stale ? 'systemStatistics.samplingInterruptedHelp' : 'systemStatistics.samplingOkHelp')}</p>
          <div className="system-health-row"><span>{t('systemStatistics.daemonCpuMemory')}</span><strong>{percent(sample.daemon.cpu_percent)} / {bytes(sample.daemon.memory_rss)}</strong></div>
          <div className="system-health-row"><span>{t('systemStatistics.daemon')} {descriptors}</span><strong data-warning={warning || undefined}>{numeric(sample.daemon.descriptors)}{limit != null && <> / {numeric(limit)}</>}</strong></div>
          <div className="system-health-row"><span>{t('systemStatistics.daemonThreads')}</span><strong>{numeric(sample.daemon.threads)}</strong></div>
          <div className="system-health-row"><span>{t('systemStatistics.intervalRetention')}</span><strong>{t('systemStatistics.intervalRetentionValue', { seconds: report!.interval_seconds, minutes: report!.retention_seconds / 60 })}</strong></div>
        </div></section>
      </div>
      <section className="system-card system-processes"><div className="system-process-head"><div><h2>{t('systemStatistics.processDetails')} <small>{numeric(sample.children_summary.process_count)}</small></h2><p>{t('systemStatistics.processScope')}</p></div><span className="system-badge">{t('systemStatistics.noDesktop')}</span></div>
        <div className="system-table-wrap"><table><thead><tr><th>{t('systemStatistics.process')}</th><th>PID</th><th>CPU ↘</th><th>{t('systemStatistics.residentMemory')}</th><th>{t('systemStatistics.threads')}</th><th>{descriptors}</th></tr></thead><tbody>
          {sample.children.map(process => <tr key={process.pid}><td><div className="system-process-name"><span className="system-process-icon"><Icon name="terminal" size={13} /></span><div>{process.name || t('systemStatistics.unknownProcess')}<small>{t('systemStatistics.childProcess')}</small></div></div></td><td className="system-number system-muted">{process.pid}</td><td className="system-number">{percent(process.cpu_percent)}</td><td className="system-number">{bytes(process.memory_rss)}</td><td className="system-number">{numeric(process.threads)}</td><td className="system-number">{numeric(process.descriptors)}</td></tr>)}
          {!sample.children.length && <tr><td colSpan={6} className="system-no-processes">{t('systemStatistics.noChildren')}</td></tr>}
        </tbody></table></div>
        <div className="system-table-footer"><span>{t('systemStatistics.childrenTotal')}</span><span className="system-mono">CPU {percent(sample.children_summary.cpu_percent)}　·　{t('systemStatistics.memory')} {bytes(sample.children_summary.memory_rss)}　·　{descriptors} {numeric(sample.children_summary.descriptors)}</span></div>
      </section>
      <div className="system-footnote"><span>{t(sample.descriptor_kind === 'handles' ? 'systemStatistics.handlesHelp' : 'systemStatistics.descriptorsHelp')}</span><span>{t('systemStatistics.historyHelp')}</span></div>
    </>}
  </div>
}
