import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import {
  statisticsApi,
  type StatisticsEngineRow,
  type StatisticsProjectRow,
  type StatisticsReport,
  type StatisticsStageRow,
  type StatisticsTrendPoint,
  type StatisticsWorkflowRow,
} from '../api/client'
import Button from '../components/Button'
import Icon from '../components/Icon'
import { useI18n } from '../i18n'
import { useTaskStore } from '../stores/taskStore'
import { formatDuration } from '../utils/datetime'
import { formatCompactMetric, formatRate, seriesPoints, trendTooltipContent } from '../utils/statistics'


type RangeKey = '7d' | '30d' | '90d' | 'all' | 'custom'


function localDate(offsetDays = 0): string {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}


function startOfLocalDate(value: string): string {
  return new Date(`${value}T00:00:00`).toISOString()
}


function endOfLocalDate(value: string): string {
  const date = new Date(`${value}T00:00:00`)
  date.setDate(date.getDate() + 1)
  return date.toISOString()
}


function MetricCard({ label, value, tone, change, changeLabel }: {
  label: string
  value: string
  tone?: 'success' | 'danger'
  change?: string
  changeLabel?: string
}) {
  return (
    <div className="statistics-metric-card">
      <div className="statistics-metric-label">{label}</div>
      <div className="statistics-metric-value" data-tone={tone}>{value}</div>
      {change && <div className="statistics-metric-change"><strong>{change}</strong> {changeLabel}</div>}
    </div>
  )
}


function signedMetric(value: number | null, locale: string): string | undefined {
  if (value === null || !Number.isFinite(value)) return undefined
  const prefix = value > 0 ? '+' : ''
  return `${prefix}${formatCompactMetric(value, locale)}`
}


function signedRate(value: number | null, locale: string): string | undefined {
  if (value === null || !Number.isFinite(value)) return undefined
  const prefix = value > 0 ? '+' : ''
  return `${prefix}${formatRate(value, locale)}`
}


function signedDuration(value: number | null, t: ReturnType<typeof useI18n>['t']): string | undefined {
  if (value === null || !Number.isFinite(value)) return undefined
  const prefix = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${prefix}${formatDuration(Math.abs(value), t)}`
}


function TrendChart({
  title,
  data,
  mode,
  successLabel,
  failedLabel,
  totalTokensLabel,
  locale,
}: {
  title: string
  data: StatisticsTrendPoint[]
  mode: 'runs' | 'tokens'
  successLabel: string
  failedLabel: string
  totalTokensLabel: string
  locale: string
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const width = 600
  const height = 150
  const succeeded = data.map((point) => point.succeeded_runs)
  const failed = data.map((point) => point.failed_runs)
  const tokens = data.map((point) => point.total_tokens)
  const maximum = mode === 'runs'
    ? Math.max(...succeeded, ...failed, 1)
    : Math.max(...tokens, 1)
  const activePoint = activeIndex === null ? null : data[activeIndex]
  const tooltip = activePoint ? trendTooltipContent(activePoint, mode, locale, {
    succeeded: successLabel,
    failed: failedLabel,
    totalTokens: totalTokensLabel,
  }) : null
  const xAt = (index: number) => data.length === 1 ? width / 2 : index * width / (data.length - 1)
  const yAt = (value: number) => height - Math.max(0, value) / maximum * height

  return (
    <section className="statistics-panel statistics-chart-panel">
      <div className="statistics-panel-title-row">
        <h2>{title}</h2>
        {mode === 'runs' ? (
          <div className="statistics-legend">
            <span><i data-color="success" />{successLabel}</span>
            <span><i data-color="danger" />{failedLabel}</span>
          </div>
        ) : (
          <strong>{formatCompactMetric(tokens.reduce((sum, value) => sum + value, 0), locale)}</strong>
        )}
      </div>
      <div className="statistics-chart-wrap" onPointerLeave={() => setActiveIndex(null)}>
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={title}>
          <title>{title}</title>
          {[0, 1, 2, 3].map((line) => (
            <line
              key={line}
              x1="0" x2={width}
              y1={line * height / 3} y2={line * height / 3}
              className="statistics-chart-grid"
            />
          ))}
          {mode === 'runs' ? (
            <>
              <polyline
                points={seriesPoints(succeeded, width, height, maximum)}
                className="statistics-chart-line statistics-chart-success"
              />
              <polyline
                points={seriesPoints(failed, width, height, maximum)}
                className="statistics-chart-line statistics-chart-danger"
              />
            </>
          ) : (
            <polyline
              points={seriesPoints(tokens, width, height, maximum)}
              className="statistics-chart-line statistics-chart-token"
            />
          )}
          {activePoint && activeIndex !== null && (
            <>
              <line
                x1={xAt(activeIndex)} x2={xAt(activeIndex)} y1="0" y2={height}
                className="statistics-chart-guide"
              />
              {mode === 'runs' ? (
                <>
                  <circle cx={xAt(activeIndex)} cy={yAt(activePoint.succeeded_runs)} r="4" className="statistics-chart-dot statistics-chart-dot-success" />
                  <circle cx={xAt(activeIndex)} cy={yAt(activePoint.failed_runs)} r="4" className="statistics-chart-dot statistics-chart-dot-danger" />
                </>
              ) : (
                <circle cx={xAt(activeIndex)} cy={yAt(activePoint.total_tokens)} r="4" className="statistics-chart-dot statistics-chart-dot-token" />
              )}
            </>
          )}
          {data.map((point, index) => {
            const step = data.length > 1 ? width / (data.length - 1) : width
            const start = Math.max(0, xAt(index) - step / 2)
            const end = Math.min(width, xAt(index) + step / 2)
            const content = trendTooltipContent(point, mode, locale, {
              succeeded: successLabel,
              failed: failedLabel,
              totalTokens: totalTokensLabel,
            })
            return (
              <rect
                key={point.bucket}
                x={start} y="0" width={end - start} height={height}
                className="statistics-chart-hit-area"
                tabIndex={0}
                aria-label={content.accessibleText}
                onPointerEnter={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
                onBlur={() => setActiveIndex(null)}
              >
                <title>{content.accessibleText}</title>
              </rect>
            )
          })}
        </svg>
        {tooltip && activeIndex !== null && (
          <div
            className="statistics-chart-tooltip"
            data-edge={activeIndex === 0 ? 'start' : activeIndex === data.length - 1 ? 'end' : undefined}
            style={{ left: `${data.length === 1 ? 50 : activeIndex / (data.length - 1) * 100}%` }}
            role="status"
          >
            <strong>{tooltip.bucket}</strong>
            {tooltip.items.map((item) => (
              <span key={item.label}><i data-color={item.tone} />{item.label}<b>{item.value}</b></span>
            ))}
          </div>
        )}
      </div>
      <div className="statistics-chart-axis">
        <span>{data[0]?.bucket ?? ''}</span>
        <span>{data.at(-1)?.bucket ?? ''}</span>
      </div>
    </section>
  )
}


function TableShell({ title, hint, children }: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="statistics-panel">
      <div className="statistics-panel-title-row">
        <h2>{title}</h2>
        {hint && <span>{hint}</span>}
      </div>
      <div className="statistics-table-wrap">{children}</div>
    </section>
  )
}


export default function StatisticsPage() {
  const { t, locale } = useI18n()
  const [searchParams, setSearchParams] = useSearchParams()
  const [report, setReport] = useState<StatisticsReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [customStart, setCustomStart] = useState(searchParams.get('start') || localDate(-30))
  const [customEnd, setCustomEnd] = useState(searchParams.get('end') || localDate())
  const taskStatusEvents = useTaskStore((state) => state.taskStatusEvents)

  const projectId = searchParams.get('project_id') || undefined
  const workflowId = searchParams.get('workflow_id') || undefined
  const rawRange = searchParams.get('range')
  const range: RangeKey = ['7d', '30d', '90d', 'all', 'custom'].includes(rawRange || '')
    ? rawRange as RangeKey
    : '30d'

  const fetchReport = useCallback(async () => {
    if (range === 'custom' && (!searchParams.get('start') || !searchParams.get('end'))) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const result = await statisticsApi.overview({
        projectId,
        workflowId,
        range,
        start: range === 'custom' ? startOfLocalDate(searchParams.get('start')!) : undefined,
        end: range === 'custom' ? endOfLocalDate(searchParams.get('end')!) : undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      })
      setReport(result)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('statistics.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [projectId, range, searchParams, t, workflowId])

  useEffect(() => {
    void fetchReport()
  }, [fetchReport, refreshKey])

  useEffect(() => {
    if (!taskStatusEvents) return
    const timer = window.setTimeout(() => setRefreshKey((value) => value + 1), 800)
    return () => window.clearTimeout(timer)
  }, [taskStatusEvents])

  const setScope = (nextProjectId?: string, nextWorkflowId?: string) => {
    const next = new URLSearchParams(searchParams)
    if (nextProjectId) next.set('project_id', nextProjectId)
    else next.delete('project_id')
    if (nextWorkflowId) next.set('workflow_id', nextWorkflowId)
    else next.delete('workflow_id')
    setSearchParams(next)
  }

  const setRange = (nextRange: RangeKey) => {
    const next = new URLSearchParams(searchParams)
    next.set('range', nextRange)
    if (nextRange !== 'custom') {
      next.delete('start')
      next.delete('end')
    }
    setSearchParams(next)
  }

  const applyCustomRange = () => {
    if (!customStart || !customEnd || customStart > customEnd) return
    const next = new URLSearchParams(searchParams)
    next.set('range', 'custom')
    next.set('start', customStart)
    next.set('end', customEnd)
    setSearchParams(next)
  }

  const kpis = useMemo(() => report ? [
    { label: t('statistics.projects'), value: formatCompactMetric(report.summary.project_count, locale) },
    { label: t('statistics.workflows'), value: formatCompactMetric(report.summary.workflow_count, locale) },
    {
      label: t('statistics.tasks'), value: formatCompactMetric(report.summary.task_count, locale),
      change: signedMetric(report.comparison?.changes.task_count ?? null, locale),
      changeLabel: t('statistics.previousPeriod'),
    },
    {
      label: t('statistics.runs'), value: formatCompactMetric(report.summary.run_count, locale),
      change: signedMetric(report.comparison?.changes.run_count ?? null, locale),
      changeLabel: t('statistics.previousPeriod'),
    },
    {
      label: t('statistics.successRate'), value: formatRate(report.summary.success_rate, locale), tone: 'success' as const,
      change: signedRate(report.comparison?.changes.success_rate ?? null, locale),
      changeLabel: t('statistics.previousPeriod'),
    },
    {
      label: t('statistics.failedRuns'), value: formatCompactMetric(report.summary.failed_runs, locale), tone: 'danger' as const,
      change: signedMetric(report.comparison?.changes.failed_runs ?? null, locale),
      changeLabel: t('statistics.previousPeriod'),
    },
    {
      label: t('statistics.totalTokens'), value: formatCompactMetric(report.summary.total_tokens, locale),
      change: signedMetric(report.comparison?.changes.total_tokens ?? null, locale),
      changeLabel: t('statistics.previousPeriod'),
    },
    {
      label: t('statistics.averageDuration'),
      value: report.summary.average_duration_ms === null
        ? '—'
        : formatDuration(report.summary.average_duration_ms, t),
      change: signedDuration(report.comparison?.changes.average_duration_ms ?? null, t),
      changeLabel: t('statistics.previousPeriod'),
    },
  ] : [], [locale, report, t])

  return (
    <div className="statistics-page">
      <header className="statistics-header">
        <div>
          <div className="statistics-breadcrumbs">
            <button onClick={() => setScope()}>{t('statistics.global')}</button>
            {report?.scope.project_name && (
              <>
                <span>/</span>
                <button onClick={() => setScope(report.scope.project_id || undefined)}>
                  {report.scope.project_name}
                </button>
              </>
            )}
            {report?.scope.workflow_name && (
              <><span>/</span><strong>{report.scope.workflow_name}</strong></>
            )}
          </div>
          <h1>{t('statistics.title')}</h1>
          <p>{t('statistics.subtitle')}</p>
        </div>
        <div className="statistics-header-actions">
          <select value={range} onChange={(event) => setRange(event.target.value as RangeKey)}>
            <option value="7d">{t('statistics.range7d')}</option>
            <option value="30d">{t('statistics.range30d')}</option>
            <option value="90d">{t('statistics.range90d')}</option>
            <option value="all">{t('statistics.rangeAll')}</option>
            <option value="custom">{t('statistics.rangeCustom')}</option>
          </select>
          <Button
            variant="ghost"
            onClick={() => setRefreshKey((value) => value + 1)}
            disabled={loading}
            title={t('common.refresh')}
          >
            <Icon name="refresh" size={14} className={loading ? 'statistics-refreshing' : undefined} />
            {t('common.refresh')}
          </Button>
        </div>
      </header>

      {range === 'custom' && (
        <div className="statistics-custom-range">
          <label>{t('statistics.startDate')}<input type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} /></label>
          <label>{t('statistics.endDate')}<input type="date" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} /></label>
          <Button onClick={applyCustomRange} disabled={!customStart || !customEnd || customStart > customEnd}>
            {t('statistics.applyRange')}
          </Button>
        </div>
      )}

      {loading && !report ? (
        <div className="statistics-state"><span className="task-status-spinner" />{t('common.loading')}</div>
      ) : error ? (
        <div className="statistics-state statistics-error">
          <span>{t('statistics.loadFailed')} · {error}</span>
          <Button variant="ghost" onClick={() => setRefreshKey((value) => value + 1)}>{t('common.retry')}</Button>
        </div>
      ) : report ? (
        <div className="statistics-content">
          <div className="statistics-metrics">
            {kpis.map((item) => <MetricCard key={item.label} {...item} />)}
          </div>

          {report.summary.run_count === 0 && (
            <div className="statistics-empty-note">{t('statistics.noActivity')}</div>
          )}

          <div className="statistics-chart-grid-layout">
            <TrendChart
              title={t('statistics.runTrend')}
              data={report.trend}
              mode="runs"
              successLabel={t('statistics.succeeded')}
              failedLabel={t('statistics.failed')}
              totalTokensLabel={t('statistics.totalTokens')}
              locale={locale}
            />
            <TrendChart
              title={t('statistics.tokenTrend')}
              data={report.trend}
              mode="tokens"
              successLabel=""
              failedLabel=""
              totalTokensLabel={t('statistics.totalTokens')}
              locale={locale}
            />
          </div>

          <section className="statistics-panel">
            <div className="statistics-panel-title-row"><h2>{t('statistics.qualityOverview')}</h2></div>
            <div className="statistics-quality-grid">
              <MetricCard label={t('statistics.stepFailureRate')} value={formatRate(report.quality.step_failure_rate, locale)} tone={report.quality.step_failure_rate ? 'danger' : undefined} />
              <MetricCard label={t('statistics.retryCount')} value={formatCompactMetric(report.quality.retry_count, locale)} />
              <MetricCard label={t('statistics.reviewPassRate')} value={formatRate(report.quality.review_pass_rate, locale)} />
              <MetricCard label={t('statistics.pendingReviews')} value={formatCompactMetric(report.quality.review_pending, locale)} />
              <MetricCard label={t('statistics.p95Duration')} value={report.summary.p95_duration_ms === null ? '—' : formatDuration(report.summary.p95_duration_ms, t)} />
              <MetricCard
                label={t('statistics.cacheHitRate')}
                value={formatRate(
                  report.summary.cache_rate,
                  locale,
                )}
              />
            </div>
          </section>

          {report.scope.level === 'global' && (
            <ProjectTable
              rows={report.projects}
              locale={locale}
              onSelect={(id) => setScope(id)}
            />
          )}
          {report.scope.level === 'project' && (
            <WorkflowTable
              rows={report.workflows}
              locale={locale}
              onSelect={(id) => setScope(report.scope.project_id || undefined, id)}
            />
          )}
          {report.scope.level === 'workflow' && <StageTable rows={report.stages} locale={locale} />}
          <EngineTable rows={report.engines} locale={locale} />

          <div className="statistics-coverage" title={t('statistics.tokenCoverageHelp')}>
            {t('statistics.tokenCoverage', { rate: formatRate(report.data_quality.token_coverage, locale) })}
            <span>·</span>
            {t('statistics.tokenCoverageHelp')}
          </div>
        </div>
      ) : null}
    </div>
  )
}


function ProjectTable({ rows, locale, onSelect }: {
  rows: StatisticsProjectRow[]
  locale: string
  onSelect: (id: string) => void
}) {
  const { t } = useI18n()
  return (
    <TableShell title={t('statistics.projectBreakdown')} hint={t('statistics.drilldownHint')}>
      <table className="statistics-table"><thead><tr>
        <th>{t('statistics.name')}</th><th>{t('statistics.workflowCount')}</th>
        <th>{t('statistics.taskCount')}</th><th>{t('statistics.runCount')}</th>
        <th>{t('statistics.successRate')}</th><th>{t('statistics.failedRuns')}</th>
        <th>{t('statistics.totalTokens')}</th><th>{t('statistics.averageDuration')}</th>
      </tr></thead><tbody>{rows.map((row) => (
        <tr key={row.id} onClick={() => onSelect(row.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') onSelect(row.id) }}>
          <td className="statistics-name-cell"><Icon name="folder" size={14} />{row.name}<Icon name="chevron-right" size={13} /></td>
          <td>{formatCompactMetric(row.workflow_count, locale)}</td>
          <td>{formatCompactMetric(row.task_count, locale)}</td>
          <td>{formatCompactMetric(row.run_count, locale)}</td>
          <td>{formatRate(row.success_rate, locale)}</td>
          <td data-danger={row.failed_runs > 0}>{formatCompactMetric(row.failed_runs, locale)}</td>
          <td>{formatCompactMetric(row.total_tokens, locale)}</td>
          <td>{row.average_duration_ms === null ? '—' : formatDuration(row.average_duration_ms, t)}</td>
        </tr>
      ))}</tbody></table>
    </TableShell>
  )
}


function WorkflowTable({ rows, locale, onSelect }: {
  rows: StatisticsWorkflowRow[]
  locale: string
  onSelect: (id: string) => void
}) {
  const { t } = useI18n()
  return (
    <TableShell title={t('statistics.workflowBreakdown')} hint={t('statistics.drilldownHint')}>
      <table className="statistics-table"><thead><tr>
        <th>{t('statistics.name')}</th><th>{t('statistics.nodeCount')}</th>
        <th>{t('statistics.taskCount')}</th><th>{t('statistics.runCount')}</th>
        <th>{t('statistics.successRate')}</th><th>{t('statistics.failedRuns')}</th>
        <th>{t('statistics.totalTokens')}</th><th>{t('statistics.averageDuration')}</th>
      </tr></thead><tbody>{rows.map((row) => (
        <tr
          key={row.id}
          onClick={() => { if (row.drilldown_available) onSelect(row.id) }}
          tabIndex={row.drilldown_available ? 0 : undefined}
          onKeyDown={(event) => { if (row.drilldown_available && event.key === 'Enter') onSelect(row.id) }}
        >
          <td className="statistics-name-cell"><Icon name="external-link" size={14} />{row.name}{row.deleted && <small>{t('statistics.deleted')}</small>}{row.drilldown_available && <Icon name="chevron-right" size={13} />}</td>
          <td>{formatCompactMetric(row.node_count, locale)}</td>
          <td>{formatCompactMetric(row.task_count, locale)}</td>
          <td>{formatCompactMetric(row.run_count, locale)}</td>
          <td>{formatRate(row.success_rate, locale)}</td>
          <td data-danger={row.failed_runs > 0}>{formatCompactMetric(row.failed_runs, locale)}</td>
          <td>{formatCompactMetric(row.total_tokens, locale)}</td>
          <td>{row.average_duration_ms === null ? '—' : formatDuration(row.average_duration_ms, t)}</td>
        </tr>
      ))}</tbody></table>
    </TableShell>
  )
}


function StageTable({ rows, locale }: { rows: StatisticsStageRow[]; locale: string }) {
  const { t } = useI18n()
  return (
    <TableShell title={t('statistics.stageBreakdown')}>
      <table className="statistics-table"><thead><tr>
        <th>{t('statistics.name')}</th><th>{t('statistics.attemptCount')}</th>
        <th>{t('statistics.retryCount')}</th><th>{t('statistics.failureRate')}</th>
        <th>{t('statistics.reviewPassRate')}</th><th>{t('statistics.totalTokens')}</th>
        <th>{t('statistics.averageDuration')}</th><th>{t('statistics.p95Duration')}</th>
      </tr></thead><tbody>{rows.map((row) => (
        <tr key={row.step_key}>
          <td className="statistics-name-cell"><span className="statistics-stage-dot" />{row.name}<code>{row.step_key}</code></td>
          <td>{formatCompactMetric(row.attempt_count, locale)}</td>
          <td>{formatCompactMetric(row.retry_count, locale)}</td>
          <td data-danger={(row.failure_rate || 0) > 0}>{formatRate(row.failure_rate, locale)}</td>
          <td>{formatRate(row.review_pass_rate, locale)}</td>
          <td>{formatCompactMetric(row.total_tokens, locale)}</td>
          <td>{row.average_duration_ms === null ? '—' : formatDuration(row.average_duration_ms, t)}</td>
          <td>{row.p95_duration_ms === null ? '—' : formatDuration(row.p95_duration_ms, t)}</td>
        </tr>
      ))}</tbody></table>
    </TableShell>
  )
}


function EngineTable({ rows, locale }: { rows: StatisticsEngineRow[]; locale: string }) {
  const { t } = useI18n()
  if (rows.length === 0) return null
  return (
    <TableShell title={t('statistics.engineBreakdown')}>
      <table className="statistics-table"><thead><tr>
        <th>{t('statistics.name')}</th><th>{t('statistics.model')}</th>
        <th>{t('statistics.callCount')}</th><th>{t('statistics.attemptCount')}</th>
        <th>{t('statistics.failureRate')}</th><th>{t('statistics.totalTokens')}</th>
        <th>{t('statistics.averageDuration')}</th>
      </tr></thead><tbody>{rows.map((row) => (
        <tr key={`${row.engine}:${row.model}`}>
          <td className="statistics-name-cell"><Icon name="terminal" size={14} />{row.engine}</td>
          <td>{row.model || '—'}</td>
          <td>{formatCompactMetric(row.call_count, locale)}</td>
          <td>{formatCompactMetric(row.attempt_count, locale)}</td>
          <td data-danger={(row.failure_rate || 0) > 0}>{formatRate(row.failure_rate, locale)}</td>
          <td>{formatCompactMetric(row.total_tokens, locale)}</td>
          <td>{row.average_duration_ms === null ? '—' : formatDuration(row.average_duration_ms, t)}</td>
        </tr>
      ))}</tbody></table>
    </TableShell>
  )
}
