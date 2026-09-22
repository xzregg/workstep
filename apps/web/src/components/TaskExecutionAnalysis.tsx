import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  taskApi,
  type TaskExecutionReport,
  type TaskExecutionSegment,
} from '../api/client'
import { useI18n } from '../i18n'
import { useTaskStore } from '../stores/taskStore'
import { formatDuration } from '../utils/datetime'
import { formatCompactMetric } from '../utils/statistics'
import Button from './Button'
import Icon from './Icon'
import MarqueeText from './MarqueeText'
import './TaskExecutionAnalysis.css'

interface TaskExecutionAnalysisProps {
  taskId: string
  projectId?: string
  loadReport?: () => Promise<TaskExecutionReport>
}

interface TaskExecutionAnalysisViewProps {
  report: TaskExecutionReport
}

function formatCost(value: number, currency: string, locale: string) {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value)
}

function timestamp(value: string, locale: string) {
  return new Date(value).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function statusTone(status: string) {
  if (['succeeded', 'passed', 'completed'].includes(status)) return 'done'
  if (['failed', 'rejected', 'cancelled'].includes(status)) return 'failed'
  if (['running', 'pending'].includes(status)) return status === 'running' ? 'running' : 'waiting'
  return 'neutral'
}

function statusLabel(status: string, t: ReturnType<typeof useI18n>['t']) {
  const labels: Record<string, string> = {
    succeeded: t('executionAnalysis.succeeded'),
    passed: t('executionAnalysis.passed'),
    completed: t('executionAnalysis.succeeded'),
    failed: t('executionAnalysis.failed'),
    rejected: t('executionAnalysis.rejected'),
    cancelled: t('executionAnalysis.cancelled'),
    running: t('executionAnalysis.running'),
    pending: t('executionAnalysis.waiting'),
    superseded: t('executionAnalysis.superseded'),
    reused: t('executionAnalysis.reused'),
    skipped: t('executionAnalysis.skipped'),
  }
  return labels[status] || status
}

function useTaskExecutionReport(
  taskId: string,
  projectId?: string,
  loadReport?: () => Promise<TaskExecutionReport>,
) {
  const { t } = useI18n()
  const [report, setReport] = useState<TaskExecutionReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const loadingRef = useRef(false)
  const queuedRef = useRef(false)
  const mountedRef = useRef(true)
  const runningRef = useRef(false)
  const taskStatusEvents = useTaskStore((state) => state.taskStatusEvents)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const load = useCallback(async () => {
    if (loadingRef.current) {
      queuedRef.current = true
      return
    }
    loadingRef.current = true
    do {
      queuedRef.current = false
      if (mountedRef.current) {
        setLoading(true)
        setError('')
      }
      try {
        const next = loadReport
          ? await loadReport()
          : await taskApi.executionReport(taskId, projectId!)
        if (mountedRef.current) {
          runningRef.current = next.runs.some((run) => run.status === 'running')
          setReport(next)
        }
      } catch (reason) {
        if (mountedRef.current) {
          setError(reason instanceof Error ? reason.message : t('executionAnalysis.loadFailed'))
        }
      }
    } while (queuedRef.current && mountedRef.current)
    loadingRef.current = false
    if (mountedRef.current) setLoading(false)
  }, [loadReport, projectId, t, taskId])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, taskStatusEvents ? 350 : 0)
    const interval = window.setInterval(() => {
      if (runningRef.current) void load()
    }, 5000)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(interval)
    }
  }, [load, taskStatusEvents])

  return { report, loading, error, reload: load }
}

export default function TaskExecutionAnalysis({ taskId, projectId, loadReport }: TaskExecutionAnalysisProps) {
  const { t } = useI18n()
  const { report, loading, error, reload } = useTaskExecutionReport(taskId, projectId, loadReport)

  if (loading && !report) {
    return <div className="execution-analysis-state"><span className="task-status-spinner" />{t('common.loading')}</div>
  }
  if (error && !report) {
    return (
      <div className="execution-analysis-state execution-analysis-state--error">
        <span>{t('executionAnalysis.loadFailed')} · {error}</span>
        <Button variant="ghost" onClick={() => { void reload() }}>{t('common.retry')}</Button>
      </div>
    )
  }
  if (!report) return null
  return <TaskExecutionAnalysisView report={report} />
}

export function TaskExecutionAnalysisView({ report }: TaskExecutionAnalysisViewProps) {
  const { t, locale } = useI18n()
  const [roundFilter, setRoundFilter] = useState<number | 'all'>('all')
  const [timeMode, setTimeMode] = useState<'relative' | 'clock'>('relative')
  const [selected, setSelected] = useState<TaskExecutionSegment | null>(null)
  const userBreakdown = report.user_breakdown ?? []

  useEffect(() => {
    if (!selected) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [selected])

  const visibleRuns = useMemo(() => report.runs.filter((run) => (
    roundFilter === 'all' || run.round === roundFilter
  )), [report.runs, roundFilter])
  const visibleSegments = useMemo(() => report.segments.filter((segment) => (
    roundFilter === 'all' || segment.round === roundFilter
  )), [report.segments, roundFilter])
  const domain = useMemo(() => {
    const starts = visibleSegments.flatMap((segment) => segment.started_at ? [Date.parse(segment.started_at)] : [])
    const ends = visibleSegments.flatMap((segment) => [
      Date.parse(segment.ended_at || report.generated_at),
    ])
    const start = starts.length ? Math.min(...starts) : Date.parse(report.generated_at)
    const end = ends.length ? Math.max(...ends) : start + 1
    return { start, end: Math.max(end, start + 1), span: Math.max(1, end - start) }
  }, [report.generated_at, visibleSegments])
  const ticks = Array.from({ length: 5 }, (_, index) => domain.start + domain.span * index / 4)

  const metrics = [
    {
      label: t('executionAnalysis.totalDuration'),
      value: formatDuration(report.summary.duration_ms, t),
      note: report.runs.some((run) => run.status === 'running')
        ? t('executionAnalysis.currentlyRunning')
        : t('executionAnalysis.completed'),
    },
    {
      label: t('executionAnalysis.totalTokens'),
      value: formatCompactMetric(report.summary.total_tokens, locale),
      note: t('executionAnalysis.coverage', {
        rate: report.summary.usage_coverage === null
          ? '—'
          : `${Math.round(report.summary.usage_coverage * 100)}%`,
      }),
    },
    {
      label: t('executionAnalysis.totalCost'),
      value: formatCost(report.summary.cost, report.currency, locale),
      note: report.summary.estimated_cost > 0
        ? t('executionAnalysis.estimatedCost', {
          value: formatCost(report.summary.estimated_cost, report.currency, locale),
        })
        : t('executionAnalysis.providerReported'),
    },
    {
      label: t('executionAnalysis.modelCalls'),
      value: `${report.data_quality.reported_usage_calls}`,
      note: t('executionAnalysis.executionAttempts', { count: report.summary.attempt_count }),
    },
    {
      label: t('executionAnalysis.retries'),
      value: `${report.summary.retry_count}`,
      note: t('executionAnalysis.runRounds', { count: report.summary.run_count }),
    },
  ]

  const openStep = (stepKey: string) => {
    const segment = [...report.segments].reverse().find((item) => item.step_key === stepKey)
    if (segment) setSelected(segment)
  }

  return (
    <div className="execution-analysis">
      <div className="execution-analysis-heading">
        <div><h2>{t('executionAnalysis.title')}</h2><p>{t('executionAnalysis.subtitle')}</p></div>
        <span className="execution-analysis-live"><i />{t('executionAnalysis.liveUpdate')}</span>
      </div>

      <div className="execution-analysis-metrics">
        {metrics.map((metric) => (
          <div className="execution-analysis-metric" key={metric.label}>
            <span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.note}</small>
          </div>
        ))}
      </div>

      <section className="execution-analysis-panel">
        <div className="execution-analysis-panel-head">
          <div><strong>{t('executionAnalysis.timeline')}</strong><small>{t('executionAnalysis.timelineHint')}</small></div>
          <div className="execution-analysis-controls">
            <select value={timeMode} onChange={(event) => setTimeMode(event.target.value as 'relative' | 'clock')} aria-label={t('executionAnalysis.timeMode')}>
              <option value="relative">{t('executionAnalysis.relativeTime')}</option>
              <option value="clock">{t('executionAnalysis.clockTime')}</option>
            </select>
            <button type="button" className={roundFilter === 'all' ? 'is-active' : ''} data-round-filter="all" onClick={() => setRoundFilter('all')}>{t('executionAnalysis.allRounds')}</button>
            {report.runs.map((run) => (
              <button type="button" className={roundFilter === run.round ? 'is-active' : ''} data-round-filter={run.round} key={run.id} onClick={() => setRoundFilter(run.round)}>{t('executionAnalysis.round', { round: run.round })}</button>
            ))}
          </div>
        </div>
        {visibleRuns.length === 0 ? (
          <div className="execution-analysis-empty">{t('executionAnalysis.noRuns')}</div>
        ) : (
          <div className="execution-gantt-scroll">
            <div className="execution-gantt">
              <div className="execution-gantt-axis-label">{t('executionAnalysis.stepAttempt')}</div>
              <div className="execution-gantt-axis">
                {ticks.map((tick, index) => (
                  <span key={tick} style={{ left: `${index * 25}%` }}>
                    {timeMode === 'clock'
                      ? timestamp(new Date(tick).toISOString(), locale).slice(0, 5)
                      : formatDuration(tick - domain.start, t)}
                  </span>
                ))}
              </div>
              {visibleRuns.map((run) => {
                const runSegments = visibleSegments.filter((segment) => segment.workflow_run_id === run.id)
                return (
                  <div className="execution-gantt-round" key={run.id}>
                    <div className="execution-gantt-round-title">
                      <div className="execution-gantt-round-title-label">
                        <strong>{t('executionAnalysis.round', { round: run.round })}</strong>
                        <span>{run.restart_from_step_key ? t('executionAnalysis.restartedFrom', { step: run.restart_from_step_key }) : statusLabel(run.status, t)}</span>
                      </div>
                    </div>
                    {runSegments.map((segment) => {
                      const start = segment.started_at ? Date.parse(segment.started_at) : domain.start
                      const end = Date.parse(segment.ended_at || report.generated_at)
                      const left = Math.max(0, (start - domain.start) / domain.span * 100)
                      const width = Math.max(1.5, (end - start) / domain.span * 100)
                      const tone = statusTone(segment.status)
                      return (
                        <div className="execution-gantt-row" key={`${segment.type}:${segment.id}`}>
                          <div className="execution-gantt-label"><i data-tone={tone}>{tone === 'done' ? '✓' : tone === 'failed' ? '!' : tone === 'running' ? '●' : '○'}</i><span><strong>{segment.type === 'review' ? t('executionAnalysis.reviewFor', { step: segment.step_title }) : segment.step_title}</strong><small>{t('executionAnalysis.attempt', { count: segment.attempt })} · {formatDuration(segment.duration_ms || 0, t)}</small></span></div>
                          <div className="execution-gantt-lane">
                            <button
                              type="button"
                              data-execution-segment={segment.id}
                              data-tone={tone}
                              data-type={segment.type}
                              style={{ left: `${left}%`, width: `${Math.min(100 - left, width)}%` }}
                              onClick={() => setSelected(segment)}
                              title={`${segment.step_title} · ${statusLabel(segment.status, t)}`}
                            >
                              <MarqueeText text={statusLabel(segment.status, t)} />
                              {segment.status === 'running' && <i className="task-status-spinner" />}
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </section>

      <section className="execution-analysis-panel">
        <div className="execution-analysis-panel-head"><strong>{t('executionAnalysis.userUsage')}</strong></div>
        {userBreakdown.length === 0 ? (
          <div className="execution-analysis-empty">{t('executionAnalysis.noUserUsage')}</div>
        ) : (
          <div className="execution-analysis-table-wrap"><table><thead><tr>
            <th>{t('executionAnalysis.user')}</th>
            <th className="is-number">{t('executionAnalysis.modelCalls')}</th>
            <th className="is-number">{t('executionAnalysis.inputTokens')}</th>
            <th className="is-number">{t('executionAnalysis.outputTokens')}</th>
            <th className="is-number">{t('executionAnalysis.cacheRead')}</th>
            <th className="is-number">Token</th>
            <th className="is-number">{t('executionAnalysis.cost')}</th>
          </tr></thead><tbody>
            {userBreakdown.map((row) => (
              <tr key={row.author_id || `name:${row.author_name}`}>
                <td>{row.author_name || t('executionAnalysis.unknownUser')}</td>
                <td className="is-number">{row.message_count}</td>
                <td className="is-number">{formatCompactMetric(row.input_tokens, locale)}</td>
                <td className="is-number">{formatCompactMetric(row.output_tokens, locale)}</td>
                <td className="is-number">{formatCompactMetric(row.cache_read_tokens + row.cache_write_tokens, locale)}</td>
                <td className="is-number">{formatCompactMetric(row.total_tokens, locale)}</td>
                <td className="is-number">{formatCost(row.cost, report.currency, locale)}</td>
              </tr>
            ))}
          </tbody></table></div>
        )}
      </section>

      <div className="execution-analysis-lower">
        <section className="execution-analysis-panel">
          <div className="execution-analysis-panel-head"><strong>{t('executionAnalysis.stepUsage')}</strong></div>
          <div className="execution-analysis-table-wrap"><table><thead><tr><th>{t('executionAnalysis.step')}</th><th>{t('executionAnalysis.status')}</th><th className="is-number">{t('executionAnalysis.attempts')}</th><th className="is-number">{t('executionAnalysis.duration')}</th><th className="is-number">Token</th><th className="is-number">{t('executionAnalysis.cost')}</th></tr></thead><tbody>
            {report.step_breakdown.map((row) => <tr key={row.step_key} onClick={() => openStep(row.step_key)}><td>{row.step_title}</td><td><span className="execution-status" data-tone={statusTone(row.status)}>{statusLabel(row.status, t)}</span></td><td className="is-number">{row.attempt_count}</td><td className="is-number">{formatDuration(row.duration_ms, t)}</td><td className="is-number">{formatCompactMetric(row.total_tokens, locale)}</td><td className="is-number">{formatCost(row.cost, report.currency, locale)}</td></tr>)}
          </tbody></table></div>
        </section>
        <section className="execution-analysis-panel">
          <div className="execution-analysis-panel-head"><strong>{t('executionAnalysis.milestones')}</strong></div>
          <div className="execution-milestones">
            {report.milestones.slice(0, 8).map((item) => <div className="execution-milestone" key={item.id}><time>{timestamp(item.at, locale)}</time><i data-tone={statusTone(item.status)} /><div><strong>{item.kind === 'task_completed' ? t('executionAnalysis.taskCompleted') : item.kind === 'review_completed' ? t('executionAnalysis.reviewCompleted', { step: item.step_title }) : t('executionAnalysis.stepCompleted', { step: item.step_title })}</strong><span>{formatDuration(item.duration_ms || 0, t)} · {formatCompactMetric(item.total_tokens, locale)} Token · {formatCost(item.cost, report.currency, locale)}</span></div></div>)}
            {report.milestones.length === 0 && <div className="execution-analysis-empty">{t('executionAnalysis.noMilestones')}</div>}
          </div>
        </section>
      </div>

      {selected && (
        <div className="execution-segment-backdrop" onClick={() => setSelected(null)}>
          <aside className="execution-segment-drawer" role="dialog" aria-modal="true" aria-label={t('executionAnalysis.segmentDetail')} onClick={(event) => event.stopPropagation()}>
            <div className="execution-segment-head"><div><h3>{selected.step_title}</h3><span className="execution-status" data-tone={statusTone(selected.status)}>{statusLabel(selected.status, t)}</span></div><Button variant="icon" onClick={() => setSelected(null)} aria-label={t('common.close')}><Icon name="x" size={16} /></Button></div>
            <dl className="execution-segment-facts"><dt>{t('executionAnalysis.roundLabel')}</dt><dd>{t('executionAnalysis.round', { round: selected.round })}</dd><dt>{t('executionAnalysis.startedAt')}</dt><dd>{selected.started_at ? new Date(selected.started_at).toLocaleString(locale) : '—'}</dd><dt>{t('executionAnalysis.duration')}</dt><dd>{formatDuration(selected.duration_ms || 0, t)}</dd><dt>{t('executionAnalysis.engine')}</dt><dd>{selected.engine || '—'}</dd><dt>{t('executionAnalysis.model')}</dt><dd>{selected.model || '—'}</dd></dl>
            <div className="execution-segment-usage"><div><strong>{t('executionAnalysis.tokenUsage')}</strong><b>{formatCompactMetric(selected.total_tokens, locale)}</b></div><span><i>{t('executionAnalysis.inputTokens')}</i><b>{formatCompactMetric(selected.input_tokens, locale)}</b></span><span><i>{t('executionAnalysis.outputTokens')}</i><b>{formatCompactMetric(selected.output_tokens, locale)}</b></span><span><i>{t('executionAnalysis.cacheRead')}</i><b>{formatCompactMetric(selected.cache_read_tokens, locale)}</b></span><span><i>{t('executionAnalysis.cost')}</i><b>{formatCost(selected.cost, report.currency, locale)}</b></span><small>{selected.cost_source === 'provider' ? t('executionAnalysis.providerReported') : selected.cost_source === 'estimated' ? t('executionAnalysis.pricingEstimated') : selected.cost_source === 'mixed' ? t('executionAnalysis.mixedCost') : t('executionAnalysis.costUnavailable')}</small></div>
          </aside>
        </div>
      )}
    </div>
  )
}
