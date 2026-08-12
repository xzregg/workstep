import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import Button from '../components/Button'
import ConfirmDialog from '../components/ConfirmDialog'
import Field from '../components/Field'
import Icon from '../components/Icon'
import Input from '../components/Input'
import MarkdownEditor from '../components/MarkdownEditor'
import ReviewOverridesEditor, { type ReviewOverride } from '../components/ReviewOverridesEditor'
import Select from '../components/Select'
import TaskDetail from './TaskDetail'
import {
  scheduleApi, workflowApi,
  type ProjectSchedule, type SchedulePayload, type ScheduleRule, type ScheduleRun,
} from '../api/client'
import { useI18n } from '../i18n'
import { useProjectStore } from '../stores/projectStore'
import { useTaskStore } from '../stores/taskStore'

type Kind = ScheduleRule['kind']

const PROGRAM_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const statusColors: Record<string, string> = {
  active: 'var(--success)', running: 'var(--accent)', succeeded: 'var(--success)',
  paused: 'var(--meta)', completed: 'var(--meta)', created: 'var(--status-ready)',
  invalid: 'var(--danger)', failed: 'var(--danger)', skipped: 'var(--warning)',
  queued: 'var(--warning)',
}

function localInputValue(date = new Date(Date.now() + 60 * 60 * 1000)) {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString() : '—'
}

interface SchedulePageProps {
  onClose?: () => void
  onCountChange?: (count: number) => void
}

export default function SchedulePage({ onClose, onCountChange }: SchedulePageProps = {}) {
  const navigate = useNavigate()
  const { t } = useI18n()
  const activeProject = useProjectStore((state) => state.activeProject)
  const activeWorkflowId = useProjectStore((state) => state.activeWorkflowId)
  const fetchTasks = useTaskStore((state) => state.fetchTasks)
  const projectId = activeProject?.id || ''
  const workflows = (activeProject?.workflows || []).filter((item) => !item.deleted)
  const defaultWorkflow = activeWorkflowId || workflows.find((item) => item.is_default)?.id || workflows[0]?.id || ''

  const [items, setItems] = useState<ProjectSchedule[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [runs, setRuns] = useState<ScheduleRun[]>([])
  const [runFilter, setRunFilter] = useState('all')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [taskConfigTab, setTaskConfigTab] = useState<'content' | 'review'>('content')

  const [workflowId, setWorkflowId] = useState(defaultWorkflow)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [startStep, setStartStep] = useState('')
  const [reviewOverrides, setReviewOverrides] = useState<Record<string, ReviewOverride>>({})
  const [kind, setKind] = useState<Kind>('daily')
  const [at, setAt] = useState(localInputValue())
  const [clock, setClock] = useState('09:00')
  const [weekdays, setWeekdays] = useState<number[]>([1])
  const [intervalEvery, setIntervalEvery] = useState(1)
  const [monthday, setMonthday] = useState(1)
  const [cron, setCron] = useState('0 9 * * *')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [timezone, setTimezone] = useState(PROGRAM_TIMEZONE)
  const [execution, setExecution] = useState<ProjectSchedule['execution_mode']>('workflow')
  const [overlap, setOverlap] = useState<ProjectSchedule['overlap_policy']>('skip')
  const [steps, setSteps] = useState<Array<{ key: string; title: string; color?: string }>>([])
  const [preview, setPreview] = useState<{ cron: string | null; next: string[] }>({ cron: null, next: [] })

  const selected = items.find((item) => item.id === selectedId) || null

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const result = await scheduleApi.list(projectId)
      setItems(result.schedules)
      onCountChange?.(result.schedules.length)
      setSelectedId((current) => current && result.schedules.some((item) => item.id === current) ? current : result.schedules[0]?.id || null)
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setLoading(false)
    }
  }, [onCountChange, projectId])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!projectId || !selectedId) { setRuns([]); return }
    scheduleApi.runs(projectId, selectedId).then((result) => setRuns(result.runs)).catch((cause) => setError((cause as Error).message))
  }, [projectId, selectedId])

  useEffect(() => {
    if (!projectId || !workflowId) { setSteps([]); return }
    workflowApi.get(workflowId, projectId).then((workflow) => {
      const nodes = workflow.steps?.nodes || workflow.steps?.steps || []
      const mapped = nodes.map((node: any) => ({
        key: String(node.type || node.key || node.id),
        title: String(node.title || node.type || node.key || node.id),
        color: node.color ? String(node.color) : undefined,
      }))
      setSteps(mapped)
      setReviewOverrides((current) => {
        if (Object.keys(current).length) return current
        return Object.fromEntries(nodes.map((node: any) => {
          const key = String(node.type || node.key || node.id)
          const review = node.review || {}
          const mode = ['skip', 'auto', 'manual'].includes(review.mode)
            ? review.mode : review.auto ? 'auto' : 'manual'
          return [key, {
            mode, auto: mode === 'auto', prompt: String(review.prompt || ''),
            maxRetries: Math.max(1, Math.min(5, Number(review.maxRetries) || 1)),
          }]
        }))
      })
    }).catch(() => setSteps([]))
  }, [projectId, workflowId])

  const buildRule = useCallback((): ScheduleRule => {
    if (kind === 'once') return { kind, run_at: at, timezone }
    const effectiveRange = {
      start_date: startDate || undefined,
      end_date: endDate || undefined,
    }
    if (kind === 'daily') return { kind, time: clock, timezone, ...effectiveRange }
    if (kind === 'weekly') return { kind, weekdays, time: clock, timezone, ...effectiveRange }
    if (kind === 'monthly') return { kind, monthdays: [monthday], time: clock, timezone, ...effectiveRange }
    if (kind === 'interval') return { kind, every: intervalEvery, unit: 'hours', weekdays, timezone, ...effectiveRange }
    return { kind: 'cron', expression: cron, timezone, ...effectiveRange }
  }, [kind, at, timezone, clock, weekdays, monthday, intervalEvery, cron, startDate, endDate])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      scheduleApi.preview(buildRule())
        .then((result) => setPreview({ cron: result.cron_expression, next: result.next_runs }))
        .catch(() => setPreview({ cron: null, next: [] }))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [buildRule])

  const fill = useCallback((item: ProjectSchedule | null) => {
    setTaskConfigTab('content')
    if (!item) {
      setWorkflowId(defaultWorkflow); setTitle(''); setDescription('')
      setStartStep(''); setReviewOverrides({}); setKind('daily'); setClock('09:00')
      setWeekdays([1]); setIntervalEvery(1); setMonthday(1); setCron('0 9 * * *'); setAt(localInputValue())
      setStartDate(''); setEndDate(''); setTimezone(PROGRAM_TIMEZONE)
      setExecution('workflow'); setOverlap('skip'); setError('')
      return
    }
    setWorkflowId(item.workflow_id); setTitle(item.task_template.title)
    setDescription(item.task_template.description || ''); setStartStep(item.task_template.start_step_key || '')
    setReviewOverrides((item.task_template.review_overrides || {}) as Record<string, ReviewOverride>)
    setKind(item.rule.kind); setTimezone(item.rule.timezone); setExecution(item.execution_mode); setOverlap(item.overlap_policy)
    if (item.rule.kind === 'once') setAt(item.rule.run_at.slice(0, 16))
    if ('time' in item.rule) setClock(item.rule.time)
    if (item.rule.kind === 'weekly') setWeekdays(item.rule.weekdays)
    if (item.rule.kind === 'interval') { setIntervalEvery(item.rule.every); setWeekdays(item.rule.weekdays) }
    if (item.rule.kind === 'monthly') setMonthday(item.rule.monthdays[0] || 1)
    if (item.rule.kind === 'cron') setCron(item.rule.expression)
    setStartDate(item.rule.start_date || ''); setEndDate(item.rule.end_date || '')
    setError('')
  }, [defaultWorkflow])

  useEffect(() => { fill(selected) }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!title.trim() || !workflowId || preview.next.length === 0) return
    const payload: SchedulePayload = {
      name: title.trim(), workflow_id: workflowId,
      task_template: {
        title: title.trim(), description: description.trim() || undefined,
        start_step_key: startStep || undefined, review_overrides: reviewOverrides,
      },
      rule: buildRule(), execution_mode: execution, overlap_policy: overlap,
    }
    setSaving(true); setError('')
    try {
      const saved = selectedId
        ? await scheduleApi.update(projectId, selectedId, payload)
        : await scheduleApi.create(projectId, payload)
      await load(); setSelectedId(saved.id)
    } catch (cause) { setError((cause as Error).message) }
    finally { setSaving(false) }
  }

  const changeStatus = async (action: 'pause' | 'resume') => {
    if (!selectedId) return
    setSaving(true)
    try { await scheduleApi[action](projectId, selectedId); await load() }
    catch (cause) { setError((cause as Error).message) }
    finally { setSaving(false) }
  }

  const filteredRuns = useMemo(
    () => runs.filter((run) => runFilter === 'all' || run.status === runFilter),
    [runs, runFilter],
  )
  const weekdaysMeta = [
    [1, t('schedules.mon')], [2, t('schedules.tue')], [3, t('schedules.wed')],
    [4, t('schedules.thu')], [5, t('schedules.fri')], [6, t('schedules.sat')], [0, t('schedules.sun')],
  ] as Array<[number, string]>

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div style={{ height: 52, padding: '0 18px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--border-soft)' }}>
        {!onClose && <Button variant="ghost" onClick={() => navigate('/tasks')}><Icon name="chevron-right" size={14} style={{ transform: 'rotate(180deg)' }} /> {t('schedules.back')}</Button>}
        <strong style={{ fontSize: 14 }}>{t('schedules.title')}</strong>
        <span style={{ color: 'var(--meta)', fontSize: 12 }}>{activeProject?.name}</span>
        <div style={{ flex: 1 }} />
        <Button variant="primary" onClick={() => { setSelectedId(null); fill(null) }}><Icon name="plus" size={13} /> {t('schedules.new')}</Button>
        {onClose && <Button variant="ghost" onClick={onClose} title={t('common.close')} aria-label={t('common.close')}><Icon name="x" size={14} /></Button>}
      </div>
      {error && <div role="alert" style={{ padding: '8px 18px', color: 'var(--danger)', background: 'var(--danger-soft)', fontSize: 12 }}>{error}</div>}
      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '280px minmax(420px, 1fr) minmax(360px, .9fr)' }}>
        <aside style={{ borderRight: '1px solid var(--border-soft)', overflow: 'auto', padding: 10 }}>
          {loading && <div className="task-status-spinner" style={{ margin: 16 }} />}
          {!loading && items.length === 0 && <div style={{ color: 'var(--meta)', padding: 18, fontSize: 13 }}>{t('schedules.empty')}</div>}
          {items.map((item) => (
            <button key={item.id} onClick={() => setSelectedId(item.id)} style={{ width: '100%', border: 0, borderRadius: 8, padding: 12, marginBottom: 6, textAlign: 'left', cursor: 'pointer', background: selectedId === item.id ? 'var(--accent-light)' : 'transparent', color: 'var(--fg)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><strong style={{ flex: 1, fontSize: 13 }}>{item.task_template.title}</strong><span style={{ color: statusColors[item.status], fontSize: 11 }}>{t(`schedules.status_${item.status}` as any)}</span></div>
              <div style={{ color: 'var(--meta)', fontSize: 11, marginTop: 5 }}>{item.summary} · {formatDate(item.next_run_at)}</div>
            </button>
          ))}
        </aside>

        <main style={{ overflow: 'auto', padding: 18, borderRight: '1px solid var(--border-soft)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <strong style={{ fontSize: 14 }}>{selectedId ? t('schedules.edit') : t('schedules.create')}</strong><div style={{ flex: 1 }} />
            {selected && selected.status === 'active' && <Button onClick={() => void changeStatus('pause')}>{t('schedules.pause')}</Button>}
            {selected && selected.status !== 'active' && selected.status !== 'completed' && <Button onClick={() => void changeStatus('resume')}>{t('schedules.resume')}</Button>}
            {selected && <Button variant="danger" onClick={() => setDeleteId(selected.id)}>{t('common.delete')}</Button>}
          </div>
          <Field label={t('schedules.workflow')}><Select value={workflowId} onChange={(event) => { setWorkflowId(event.target.value); setStartStep(''); setReviewOverrides({}) }}>{workflows.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border-soft)', marginTop: 18 }}>
            <button
              type="button"
              onClick={() => setTaskConfigTab('content')}
              style={{
                padding: '10px 16px', fontSize: 13, fontWeight: taskConfigTab === 'content' ? 600 : 400,
                border: 'none', borderBottom: taskConfigTab === 'content' ? '2px solid var(--accent)' : '2px solid transparent',
                background: 'none', cursor: 'pointer', color: taskConfigTab === 'content' ? 'var(--fg)' : 'var(--meta)',
                fontFamily: 'var(--font-body)',
              }}
            >{t('taskList.contentTab')}</button>
            <button
              type="button"
              onClick={() => setTaskConfigTab('review')}
              style={{
                padding: '10px 16px', fontSize: 13, fontWeight: taskConfigTab === 'review' ? 600 : 400,
                border: 'none', borderBottom: taskConfigTab === 'review' ? '2px solid var(--accent)' : '2px solid transparent',
                background: 'none', cursor: 'pointer', color: taskConfigTab === 'review' ? 'var(--fg)' : 'var(--meta)',
                fontFamily: 'var(--font-body)',
              }}
            >{t('taskList.reviewTab')}</button>
          </div>

          {taskConfigTab === 'content' && (
            <div style={{ paddingTop: 14 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label={t('schedules.taskTitle')}><Input value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
                <Field label={t('schedules.startStep')}><Select value={startStep} onChange={(event) => setStartStep(event.target.value)}><option value="">{t('schedules.firstStep')}</option>{steps.map((step) => <option key={step.key} value={step.key}>{step.title}</option>)}</Select></Field>
              </div>
              <div style={{ marginTop: 12 }}><Field label={t('schedules.description')}><MarkdownEditor value={description} onChange={setDescription} projectId={projectId} /></Field></div>
            </div>
          )}

          {taskConfigTab === 'review' && (
            <div style={{ paddingTop: 14 }}>
              <ReviewOverridesEditor value={reviewOverrides} onChange={setReviewOverrides} lanes={steps.map((step) => ({ key: step.key, label: step.title, color: step.color }))} startStepKey={startStep || steps[0]?.key} projectId={projectId} />
            </div>
          )}

          <div className="schedule-frequency-section">
            <div className="schedule-frequency-label">{t('schedules.frequency')}</div>
            <div className="schedule-frequency-tabs">
              <button type="button" className={kind !== 'interval' && kind !== 'once' ? 'active' : ''} onClick={() => setKind('daily')}>{t('schedules.frequencyCycle')}</button>
              <button type="button" className={kind === 'interval' ? 'active' : ''} onClick={() => setKind('interval')}>{t('schedules.frequencyInterval')}</button>
              <button type="button" className={kind === 'once' ? 'active' : ''} onClick={() => setKind('once')}>{t('schedules.frequencyOnce')}</button>
            </div>

            {kind !== 'interval' && kind !== 'once' && (
              <div className="schedule-frequency-row">
                <Select value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
                  <option value="daily">{t('schedules.daily')}</option>
                  <option value="weekly">{t('schedules.weekly')}</option>
                  <option value="monthly">{t('schedules.monthly')}</option>
                  <option value="cron">Cron</option>
                </Select>
                {kind !== 'cron' && <Input type="time" value={clock} onChange={(event) => setClock(event.target.value)} />}
                {kind === 'monthly' && <Input type="number" min={1} max={31} value={monthday} onChange={(event) => setMonthday(Number(event.target.value))} aria-label={t('schedules.monthday')} />}
                {kind === 'cron' && <Input value={cron} onChange={(event) => setCron(event.target.value)} placeholder="0 9 * * 1-5" aria-label="Cron" />}
              </div>
            )}

            {kind === 'interval' && (
              <div className="schedule-frequency-row schedule-interval-row">
                <span>{t('schedules.every')}</span>
                <Input type="number" min={1} max={24} value={intervalEvery} onChange={(event) => setIntervalEvery(Number(event.target.value))} />
                <span>{t('schedules.hours')}</span>
              </div>
            )}

            {kind === 'once' && <div className="schedule-frequency-row"><Input type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} /></div>}

            {(kind === 'weekly' || kind === 'interval') && (
              <div className="schedule-weekday-tabs">
                {weekdaysMeta.map(([day, label]) => (
                  <button key={day} type="button" className={weekdays.includes(day) ? 'active' : ''} onClick={() => setWeekdays((value) => value.includes(day) ? value.filter((item) => item !== day) : [...value, day])}>{label}</button>
                ))}
              </div>
            )}

            {kind !== 'once' && (
              <div className="schedule-effective-range">
                <div className="schedule-frequency-label">{t('schedules.effectiveRange')} <span>{t('schedules.effectiveRangeHint')}</span></div>
                <div className="schedule-date-range">
                  <Input type="date" value={startDate} onChange={(event) => { const value = event.target.value; setStartDate(value); if (endDate && value > endDate) setEndDate('') }} aria-label={t('schedules.startDate')} />
                  <span>—</span>
                  <Input type="date" value={endDate} min={startDate || undefined} onChange={(event) => setEndDate(event.target.value)} aria-label={t('schedules.endDate')} />
                </div>
              </div>
            )}
          </div>
          <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label={t('schedules.execution')}><Select value={execution} onChange={(event) => setExecution(event.target.value as ProjectSchedule['execution_mode'])}><option value="workflow">{t('schedules.followWorkflow')}</option><option value="immediate">{t('schedules.immediate')}</option><option value="manual">{t('schedules.manual')}</option></Select></Field>
            <Field label={t('schedules.overlap')}><Select value={overlap} onChange={(event) => setOverlap(event.target.value as ProjectSchedule['overlap_policy'])}><option value="skip">{t('schedules.skip')}</option><option value="parallel">{t('schedules.parallel')}</option><option value="queue">{t('schedules.queue')}</option></Select></Field>
          </div>
          <div style={{ marginTop: 14, padding: 12, borderRadius: 8, background: 'var(--surface)', fontSize: 12, color: 'var(--fg-2)' }}>
            {preview.cron && <div>Cron: <code>{preview.cron}</code></div>}
            <div style={{ marginTop: 5 }}>{t('schedules.nextRuns')}: {preview.next.slice(0, 3).map(formatDate).join(' · ') || '—'}</div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}><Button variant="primary" loading={saving} disabled={!title.trim() || !workflowId || preview.next.length === 0} onClick={() => void save()}>{t('common.save')}</Button></div>
        </main>

        <section style={{ overflow: 'auto', padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}><strong style={{ fontSize: 14 }}>{t('schedules.runs')}</strong><div style={{ flex: 1 }} /><Select value={runFilter} onChange={(event) => setRunFilter(event.target.value)} style={{ width: 130 }}><option value="all">{t('schedules.all')}</option>{['queued', 'running', 'created', 'succeeded', 'failed', 'skipped'].map((status) => <option key={status} value={status}>{t(`schedules.status_${status}` as any)}</option>)}</Select></div>
          {filteredRuns.length === 0 && <div style={{ color: 'var(--meta)', fontSize: 13, padding: 16 }}>{t('schedules.noRuns')}</div>}
          {filteredRuns.map((run) => <div key={run.id} style={{ border: '1px solid var(--border-soft)', borderRadius: 8, padding: 11, marginBottom: 8, fontSize: 12 }}><div style={{ display: 'flex', alignItems: 'center' }}><span style={{ color: statusColors[run.status], fontWeight: 600 }}>{t(`schedules.status_${run.status}` as any)}</span><span style={{ flex: 1 }} /><span style={{ color: 'var(--meta)' }}>{formatDate(run.scheduled_for)}</span></div>{run.reason && <div style={{ color: 'var(--danger)', marginTop: 6 }}>{run.reason}</div>}{run.task_id && <Button size="sm" style={{ marginTop: 7 }} onClick={async () => { await fetchTasks(projectId, selected?.workflow_id); setTaskId(run.task_id || null) }}>{t('schedules.openTask')}</Button>}</div>)}
        </section>
      </div>
      <ConfirmDialog open={deleteId !== null} title={t('schedules.deleteTitle')} message={t('schedules.deleteMessage')} danger confirmText={t('common.delete')} onCancel={() => setDeleteId(null)} onConfirm={() => { if (!deleteId) return; setSaving(true); scheduleApi.delete(projectId, deleteId).then(() => { setDeleteId(null); setSelectedId(null); fill(null); return load() }).catch((cause) => setError((cause as Error).message)).finally(() => setSaving(false)) }} />
      {taskId && <><div onClick={() => setTaskId(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.2)', zIndex: 999 }} /><TaskDetail taskId={taskId} onClose={() => setTaskId(null)} /></>}
    </div>
  )
}
