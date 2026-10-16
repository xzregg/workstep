import { useGatewayProjectPermissions } from '../hooks/useGatewayProjectPermissions'
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'

import ScheduleRuleEditor from '../components/ScheduleRuleEditor'
import TaskScheduleEditor from '../components/TaskScheduleEditor'
import ScheduleNotificationEditor, {type NotificationEditorState} from '../components/ScheduleNotificationEditor'
import ScheduleRunNotification from '../components/ScheduleRunNotification'
import AiTaskCreateChat from '../components/AiTaskCreateChat'
import Button from '../components/Button'
import ConfirmDialog from '../components/ConfirmDialog'
import Field from '../components/Field'
import Icon from '../components/Icon'
import Input from '../components/Input'
import MarqueeText from '../components/MarqueeText'
import MarkdownEditor from '../components/MarkdownEditor'
import ReviewOverridesEditor, { type ReviewOverride } from '../components/ReviewOverridesEditor'
import Select from '../components/Select'
import TaskDetail from './TaskDetail'
import './SchedulePage.css'
import {
  scheduleApi, workflowApi,
  type ProjectSchedule, type SchedulePayload, type ScheduleRule, type ScheduleRun,
} from '../api/client'
import { useI18n } from '../i18n'
import { useProjectStore } from '../stores/projectStore'
import { useTaskStore } from '../stores/taskStore'
import { useScheduleDraftState, type ScheduleEditorState } from '../hooks/useScheduleDraftState'
import type { Project } from '../api/client'

type Kind = ScheduleRule['kind']

const SPLIT_HANDLE_WIDTH = 4
const PROGRAM_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const statusColors: Record<string, string> = {
  active: 'var(--success)', running: 'var(--accent)', succeeded: 'var(--success)',
  paused: 'var(--meta)', completed: 'var(--meta)', created: 'var(--status-ready)',
  invalid: 'var(--danger)', failed: 'var(--danger)', skipped: 'var(--warning)',
  queued: 'var(--warning)', stopped: 'var(--meta)',
}

function localInputValue(date = new Date(Date.now() + 60 * 60 * 1000)) {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString() : '—'
}

function ScheduleSummary({ summary }: { summary: string }) {
  const oncePrefix = 'Once at '
  if (!summary.startsWith(oncePrefix)) return <>{summary}</>
  return <>{oncePrefix.trim()}<br />{summary.slice(oncePrefix.length)}</>
}

interface SchedulePageProps {
  onClose?: () => void
  onCountChange?: (count: number) => void
  project?: Project
  headerTarget?: HTMLElement
  tabbed?: boolean
  onEditorStateChange?: (state: ScheduleEditorState) => void
}

export default function SchedulePage({ onClose, onCountChange, project, headerTarget, tabbed, onEditorStateChange }: SchedulePageProps = {}) {
  const navigate = useNavigate()
  const { t } = useI18n()
  const selectedProject = useProjectStore((state) => state.activeProject)
  const activeProject = project ?? selectedProject
  const activeWorkflowId = useProjectStore((state) => state.activeWorkflowId)
  const fetchTasks = useTaskStore((state) => state.fetchTasks)
  const projectId = activeProject?.id || ''
  const { can } = useGatewayProjectPermissions(projectId)
  const canManage = can('schedule.manage')
  const workflows = (activeProject?.workflows || []).filter((item) => !item.deleted)
  const defaultWorkflow = (activeProject?.id === selectedProject?.id && workflows.some(item => item.id === activeWorkflowId) ? activeWorkflowId : '') || workflows.find((item) => item.is_default)?.id || workflows[0]?.id || ''
  const [draftRevision, resetDraft] = useReducer((revision: number) => revision + 1, 0)

  const [items, setItems] = useState<ProjectSchedule[]>([])
  const [listType, setListType] = useState<'once' | 'recurring'>('recurring')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [runs, setRuns] = useState<ScheduleRun[]>([])
  const [runFilter, setRunFilter] = useState('all')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notification, setNotification] = useState<NotificationEditorState>({value:{enabled:false},valid:true})
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [focusMessageId, setFocusMessageId] = useState<string | undefined>()
  const [taskId, setTaskId] = useState<string | null>(null)
  const [taskConfigTab, setTaskConfigTab] = useState<'content' | 'review'>('content')
  const [targetType, setTargetType] = useState<'project' | 'task'>('project')
  const [targetFilter, setTargetFilter] = useState('all')
  const [taskFilter, setTaskFilter] = useState('')
  const [generation, setGeneration] = useState<'static' | 'agent'>('static')
  const [instruction, setInstruction] = useState('')
  const [candidateWorkflowIds, setCandidateWorkflowIds] = useState<string[]>([])
  const [retryCount, setRetryCount] = useState(2)
  const [testOpen, setTestOpen] = useState(false)
  const [asideWidth, setAsideWidth] = useState(280)
  const [sectionWidth, setSectionWidth] = useState(() => Math.round(Math.max(280, Math.min(600, Math.min(1500, window.innerWidth * 0.96) * 2 / 5))))

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

  const acceptDefaults = useScheduleDraftState(JSON.stringify({ workflowId, title, description, startStep, reviewOverrides,
    generation, instruction, candidateWorkflowIds, retryCount, kind, at, clock, weekdays, intervalEvery,
    monthday, cron, startDate, endDate, timezone, execution, overlap, notification:notification.value }), draftRevision,
    Boolean(selectedId || creating), saving, targetType === 'project' ? onEditorStateChange : undefined)

  const visibleItems = items.filter((item) => (item.rule.kind === 'once') === (listType === 'once') && (targetFilter === 'all' || (item.target_type || 'project') === targetFilter) && (!taskFilter || (item.target_task_id || '').includes(taskFilter)))
  const selected = items.find((item) => item.id === selectedId) || null

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const result = await scheduleApi.list(projectId)
      setItems(result.schedules)
      onCountChange?.(result.schedules.length)
      setSelectedId((current) => current && result.schedules.some((item) => item.id === current) ? current : null)
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
    let active = true
    workflowApi.get(workflowId, projectId).then((workflow) => {
      if (!active) return
      const nodes = workflow.steps?.nodes || workflow.steps?.steps || []
      const mapped = nodes.map((node: any) => ({
        key: String(node.type || node.key || node.id),
        title: String(node.title || node.type || node.key || node.id),
        color: node.color ? String(node.color) : undefined,
      }))
      setSteps(mapped)
      setReviewOverrides((current) => {
        if (Object.keys(current).length) return current
        const defaults = Object.fromEntries(nodes.map((node: any) => {
          const key = String(node.type || node.key || node.id)
          const review = node.review || {}
          const mode = ['skip', 'auto', 'manual'].includes(review.mode)
            ? review.mode : review.auto ? 'auto' : 'manual'
          return [key, {
            mode, auto: mode === 'auto', prompt: String(review.prompt || ''),
            maxRetries: Math.max(1, Math.min(5, Number(review.maxRetries) || 1)),
          }]
        }))
        acceptDefaults('reviewOverrides', defaults)
        return defaults
      })
    }).catch(() => { if (active) setSteps([]) })
    return () => { active = false }
  }, [projectId, workflowId, acceptDefaults])

  const buildRule = useCallback((): ScheduleRule => {
    if (kind === 'once') return { kind, run_at: at, timezone }
    const effectiveRange = {
      start_date: startDate || undefined,
      end_date: endDate || undefined,
    }
    if (kind === 'minutes') return { kind, every: intervalEvery, timezone, ...effectiveRange }
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

  const closeTest = useCallback(() => {
    setTestOpen(false)
  }, [])

  const toggleTestAssistant = useCallback(() => {
    setTestOpen((open) => !open)
  }, [])

  const beginDividerDrag = (
    event: React.PointerEvent<HTMLDivElement>,
    edge: 'aside' | 'section',
  ) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startAside = asideWidth
    const startSection = sectionWidth
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = ''
    const handleMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX
      if (edge === 'aside') {
        setAsideWidth(Math.min(480, Math.max(180, startAside + delta)))
      } else {
        setSectionWidth(Math.min(600, Math.max(280, startSection - delta)))
      }
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
  }

  const dividerKeyDown = (edge: 'aside' | 'section') => (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const delta = event.key === 'ArrowLeft' ? -16 : 16
    if (edge === 'aside') {
      setAsideWidth((width) => Math.min(480, Math.max(180, width + delta)))
    } else {
      setSectionWidth((width) => Math.min(600, Math.max(280, width - delta)))
    }
  }

  const fill = useCallback((item: ProjectSchedule | null) => {
    resetDraft()
    setNotification({value:item?.notification || {enabled:false},valid:true})
    setTaskConfigTab('content')
    closeTest()
    setTargetType(item?.target_type || 'project')
    if (!item) {
      setGeneration('static'); setWorkflowId(defaultWorkflow); setTitle(''); setDescription('')
      setInstruction(''); setCandidateWorkflowIds(workflows.map((wf) => wf.id)); setRetryCount(2)
      setStartStep(''); setReviewOverrides({}); setKind('daily'); setClock('09:00')
      setWeekdays([1]); setIntervalEvery(1); setMonthday(1); setCron('0 9 * * *'); setAt(localInputValue())
      setStartDate(''); setEndDate(''); setTimezone(PROGRAM_TIMEZONE)
      setExecution('workflow'); setOverlap('skip'); setError('')
      return
    }
    const template = item.task_template
    setGeneration(template.mode === 'agent' ? 'agent' : 'static')
    setWorkflowId(item.workflow_id); setTitle(template.title || '')
    setDescription(item.task_template.description || ''); setStartStep(item.task_template.start_step_key || '')
    setInstruction(template.instruction || '')
    setCandidateWorkflowIds(
      template.candidate_workflow_ids?.length
        ? template.candidate_workflow_ids
        : workflows.map((wf) => wf.id),
    )
    setRetryCount(template.retry_count ?? 2)
    setReviewOverrides((item.task_template.review_overrides || {}) as Record<string, ReviewOverride>)
    setKind(item.rule.kind); setTimezone(item.rule.timezone); setExecution(item.execution_mode); setOverlap(item.overlap_policy)
    if (item.rule.kind === 'once') setAt(item.rule.run_at.slice(0, 16))
    if ('time' in item.rule) setClock(item.rule.time)
    if (item.rule.kind === 'weekly') setWeekdays(item.rule.weekdays)
    if (item.rule.kind === 'minutes') setIntervalEvery(item.rule.every)
    if (item.rule.kind === 'interval') { setIntervalEvery(item.rule.every); setWeekdays(item.rule.weekdays) }
    if (item.rule.kind === 'monthly') setMonthday(item.rule.monthdays[0] || 1)
    if (item.rule.kind === 'cron') setCron(item.rule.expression)
    setStartDate(item.rule.start_date || ''); setEndDate(item.rule.end_date || '')
    setError('')
  }, [closeTest, defaultWorkflow, workflows])

  useEffect(() => { fill(selected) }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    const agentMode = generation === 'agent'
    if (preview.next.length === 0 || !notification.valid) return
    if (agentMode ? !instruction.trim() : !workflowId) return
    const derivedTitle = title.trim() || `${description.trim().slice(0, 10)}...`
    const payload: SchedulePayload = {
      name: agentMode
        ? title.trim() || (instruction.trim().slice(0, 30) || t('schedules.title'))
        : derivedTitle,
      workflow_id: agentMode ? '' : workflowId,
      task_template: agentMode
        ? {
            mode: 'agent',
            instruction: instruction.trim(),
            title: title.trim() || undefined,
            candidate_workflow_ids: candidateWorkflowIds,
            retry_count: retryCount,
          }
        : {
            title: derivedTitle, description: description.trim() || undefined,
            start_step_key: startStep || undefined, review_overrides: reviewOverrides,
          },
      notification: notification.value, rule: buildRule(), execution_mode: execution, overlap_policy: overlap,
    }
    setSaving(true); setError('')
    try {
      const saved = selectedId
        ? await scheduleApi.update(projectId, selectedId, payload)
        : await scheduleApi.create(projectId, payload)
      await load(); setListType(saved.rule.kind === 'once' ? 'once' : 'recurring'); setCreating(false); setSelectedId(saved.id); resetDraft()
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
  const header = <div className="schedule-header" style={{ height: 52, padding: '0 18px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--border-soft)' }}>
        {(selected || creating) && <Button className="schedule-mobile-back" variant="ghost" onClick={() => { if (testOpen) { closeTest(); return } setCreating(false); setSelectedId(null); fill(null) }} aria-label={t('schedules.back')}><Icon name="chevron-right" size={16} style={{ transform: 'rotate(180deg)' }} /></Button>}
        {!onClose && <Button variant="ghost" onClick={() => navigate('/tasks')}><Icon name="chevron-right" size={14} style={{ transform: 'rotate(180deg)' }} /> {t('schedules.back')}</Button>}
        <strong style={{ fontSize: 'calc(14px * var(--font-scale))' }}>{t('schedules.title')}</strong>
        <span className="schedule-project-name" style={{ color: 'var(--meta)', fontSize: 'calc(12px * var(--font-scale))' }}>{activeProject?.name}</span>
        <div style={{ flex: 1 }} />
        {canManage && <Button className="schedule-new-button" variant="primary" onClick={() => { setCreating(true); setSelectedId(null); fill(null) }}><Icon name="plus" size={16} /> <span>{t('schedules.new')}</span></Button>}
        {onClose && <Button className="schedule-close-button" variant="ghost" onClick={onClose} title={t('common.close')} aria-label={t('common.close')}><Icon name="x" size={16} /></Button>}
      </div>

  return (
    <div className={`schedule-page${selected || creating ? ' schedule-page--editing' : ''}${creating ? ' schedule-page--creating' : ''}${testOpen && generation === 'agent' ? ' schedule-page--testing' : ''}`} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {headerTarget ? createPortal(header, headerTarget) : header}
      {error && <div role="alert" style={{ padding: '8px 18px', color: 'var(--danger)', background: 'var(--danger-soft)', fontSize: 'calc(12px * var(--font-scale))' }}>{error}</div>}
      <div className="schedule-layout" id={tabbed ? `schedule-content-${projectId}` : undefined} role={tabbed ? 'tabpanel' : undefined} aria-labelledby={tabbed ? `schedule-project-${projectId}` : undefined} style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: `${asideWidth}px ${SPLIT_HANDLE_WIDTH}px minmax(0, 1fr) ${SPLIT_HANDLE_WIDTH}px ${sectionWidth}px` }}>
        <aside className="schedule-list" style={{ overflow: 'auto', padding: 10 }}>
          <div className="schedule-list-tabs" role="tablist" aria-label={t('schedules.title')}>
            {(['recurring', 'once'] as const).map((type) => (
              <button key={type} type="button" role="tab"
                id={`schedule-type-${projectId}-${type}`}
                aria-controls={`schedule-type-list-${projectId}`}
                disabled={saving} aria-selected={listType === type} tabIndex={listType === type ? 0 : -1}
                onClick={() => setListType(type)}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                  event.preventDefault()
                  const next = event.key === 'Home' ? 'recurring' : event.key === 'End' ? 'once' : type === 'once' ? 'recurring' : 'once'
                  setListType(next)
                  document.getElementById(`schedule-type-${projectId}-${next}`)?.focus()
                }}>
                {t(type === 'once' ? 'schedules.onceTasks' : 'schedules.recurringTasks')}
              </button>
            ))}
          </div>
          <div className="schedule-target-filter">
            <Select aria-label={t('schedules.targetFilter')} value={targetFilter} onChange={e => { setTargetFilter(e.target.value); setTaskFilter('') }}><option value="all">{t('schedules.all')}</option><option value="project">{t('schedules.projectTarget')}</option><option value="task">{t('schedules.taskTarget')}</option></Select>
            {targetFilter === 'task' && <Input aria-label={t('schedules.taskIdFilter')} placeholder={t('schedules.taskIdFilter')} value={taskFilter} onChange={e => setTaskFilter(e.target.value)} />}
          </div>
          <div role="tabpanel" id={`schedule-type-list-${projectId}`} aria-labelledby={`schedule-type-${projectId}-${listType}`}>
          {loading && <div className="task-status-spinner" style={{ margin: 16 }} />}
          {!loading && visibleItems.length === 0 && <div style={{ color: 'var(--meta)', padding: 18, fontSize: 'calc(13px * var(--font-scale))' }}>{t(items.length === 0 ? 'schedules.empty' : 'schedules.emptyType')}</div>}
          {visibleItems.map((item) => (
            <button className="schedule-list-item" key={item.id} onClick={() => { setCreating(false); setSelectedId(item.id) }} style={{ display: 'block', width: '100%', minWidth: 0, border: 0, borderRadius: 8, padding: 12, marginBottom: 6, textAlign: 'left', cursor: 'pointer', background: selectedId === item.id ? 'var(--accent-light)' : 'transparent', color: 'var(--fg)' }}>
              <div className="schedule-list-title-row" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <MarqueeText
                  text={item.target_type === 'task' ? item.name : item.task_template.title || (item.task_template.mode === 'agent' ? t('schedules.agentTask') : '')}
                  style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}
                />
                <span className="schedule-list-status" style={{ flexShrink: 0, color: statusColors[item.status], fontSize: 'calc(11px * var(--font-scale))' }}>{t(`schedules.status_${item.status}` as any)}</span>
              </div>
              <div className="schedule-list-meta" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginTop: 5, color: 'var(--meta)', fontSize: 'calc(11px * var(--font-scale))', lineHeight: 1.45 }}>
                <span className="schedule-list-time" style={{ minWidth: 0 }}>{formatDate(item.next_run_at)}</span>
                <span className="schedule-list-summary" style={{ flexShrink: 0, textAlign: 'right' }}><ScheduleSummary summary={item.summary} /></span>
              </div>
              {item.target_type === 'task' && <div className="schedule-task-target">{t('schedules.taskTarget')} · {item.target_task_id}</div>}
              {item.task_template.mode === 'agent' && <div style={{ color: 'var(--accent)', fontSize: 'calc(11px * var(--font-scale))', marginTop: 4 }}>{item.task_template.candidate_workflow_ids?.length ? t('schedules.agentCandidates', { count: item.task_template.candidate_workflow_ids.length }) : t('schedules.allWorkflows')}</div>}
            </button>
          ))}
          </div>
        </aside>

        <div className="schedule-split-handle" role="separator" aria-orientation="vertical" tabIndex={0} onPointerDown={(event) => beginDividerDrag(event, 'aside')} onKeyDown={dividerKeyDown('aside')} />

        <main className="schedule-editor" style={{ overflow: 'auto', padding: 18 }}>
          {(selected || creating) && (<fieldset className="schedule-permission-fields" disabled={!canManage}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <strong style={{ fontSize: 'calc(14px * var(--font-scale))' }}>{selectedId ? t('schedules.edit') : t('schedules.create')}</strong><div style={{ flex: 1 }} />
            {canManage && selected && selected.status === 'active' && <Button onClick={() => void changeStatus('pause')}>{t('schedules.pause')}</Button>}
            {canManage && selected && selected.status !== 'active' && <Button onClick={() => void changeStatus('resume')}>{t('schedules.resume')}</Button>}
            {canManage && selected && <Button variant="danger" onClick={() => setDeleteId(selected.id)}>{t('common.delete')}</Button>}
          </div>
          {creating && <div className="schedule-frequency-tabs"><button type="button" className={targetType === 'project' ? 'active' : ''} onClick={() => setTargetType('project')}>{t('schedules.projectTarget')}</button><button type="button" className={targetType === 'task' ? 'active' : ''} onClick={() => { setTargetType('task'); closeTest() }}>{t('schedules.taskTarget')}</button></div>}
          {targetType === 'task' ? <TaskScheduleEditor key={`${projectId}:${selectedId || 'new'}`} projectId={projectId} schedule={selected} workflows={workflows} onEditorStateChange={onEditorStateChange} onSaved={saved => { setTargetFilter('all'); setTaskFilter(''); void load(); setCreating(false); setSelectedId(saved.id); setListType(saved.rule.kind === 'once' ? 'once' : 'recurring') }} /> : <>
          <div className="schedule-frequency-label">{t('schedules.generation')}</div>
          <div className="schedule-frequency-tabs">
            <button type="button" className={generation === 'static' ? 'active' : ''} onClick={() => { setGeneration('static'); closeTest() }}>{t('schedules.generationStatic')}</button>
            <button type="button" className={generation === 'agent' ? 'active' : ''} onClick={() => { setGeneration('agent'); setTaskConfigTab('content') }}>{t('schedules.generationAgent')}</button>
          </div>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border-soft)', marginTop: 18 }}>
            <button
              type="button"
              onClick={() => setTaskConfigTab('content')}
              style={{
                padding: '10px 16px', fontSize: 'calc(13px * var(--font-scale))', fontWeight: taskConfigTab === 'content' ? 600 : 400,
                border: 'none', borderBottom: taskConfigTab === 'content' ? '2px solid var(--accent)' : '2px solid transparent',
                background: 'none', cursor: 'pointer', color: taskConfigTab === 'content' ? 'var(--fg)' : 'var(--meta)',
                fontFamily: 'var(--font-body)',
              }}
            >{t('taskList.contentTab')}</button>
            {generation === 'static' && (
              <button
                type="button"
                onClick={() => setTaskConfigTab('review')}
                style={{
                  padding: '10px 16px', fontSize: 'calc(13px * var(--font-scale))', fontWeight: taskConfigTab === 'review' ? 600 : 400,
                  border: 'none', borderBottom: taskConfigTab === 'review' ? '2px solid var(--accent)' : '2px solid transparent',
                  background: 'none', cursor: 'pointer', color: taskConfigTab === 'review' ? 'var(--fg)' : 'var(--meta)',
                  fontFamily: 'var(--font-body)',
                }}
              >{t('taskList.reviewTab')}</button>
            )}
          </div>

          {taskConfigTab === 'content' && (
            <div style={{ paddingTop: 14 }}>
              {generation === 'agent' ? (
                <>
                  <Field
                    label={t('schedules.instruction')}
                    required
                    help={t('schedules.instructionHelp')}
                    labelAction={
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!instruction.trim() && !testOpen}
                        aria-expanded={testOpen}
                        onClick={toggleTestAssistant}
                        style={{ border: '1px solid var(--border-soft)' }}
                      >
                        <Icon name="sparkles" size={13} /> {t('schedules.testGenerate')}
                      </Button>
                    }
                  >
                    <MarkdownEditor value={instruction} onChange={setInstruction} projectId={projectId} placeholder={t('schedules.instructionPlaceholder')} />
                  </Field>
                  <div className="schedule-form-grid schedule-form-grid--spaced">
                    <Field label={t('schedules.referenceTitle')} help={t('schedules.referenceTitleHelp')}><Input value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
                    <Field label={t('schedules.retryCount')} help={t('schedules.retryCountHelp')}><Input type="number" min={0} max={10} value={retryCount} onChange={(event) => setRetryCount(Math.max(0, Number(event.target.value)))} /></Field>
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <Field label={t('schedules.candidateWorkflows')} help={t('schedules.candidateWorkflowsHelp')}>
                      <div className="schedule-candidate-tabs">
                        {workflows.map((wf) => {
                          const checked = candidateWorkflowIds.includes(wf.id)
                          return (
                            <button key={wf.id} type="button" aria-pressed={checked} className={checked ? 'active' : ''} onClick={() => setCandidateWorkflowIds((current) => checked ? current.filter((id) => id !== wf.id) : [...current, wf.id])}>{wf.name}</button>
                          )
                        })}
                      </div>
                    </Field>
                  </div>
                </>
              ) : (
                <>
                  <div className="schedule-form-grid">
                    <Field label={t('schedules.workflow')}><Select value={workflowId} onChange={(event) => { setWorkflowId(event.target.value); setStartStep(''); setReviewOverrides({}) }}>{workflows.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
                    <Field label={t('schedules.startStep')}><Select value={startStep} onChange={(event) => setStartStep(event.target.value)}><option value="">{t('schedules.firstStep')}</option>{steps.map((step) => <option key={step.key} value={step.key}>{step.title}</option>)}</Select></Field>
                  </div>
                  <div style={{ marginTop: 12 }}><Field label={t('schedules.taskTitle')}><Input value={title} onChange={(event) => setTitle(event.target.value)} /></Field></div>
                  <div style={{ marginTop: 12 }}><Field label={t('schedules.description')}><MarkdownEditor value={description} onChange={setDescription} projectId={projectId} /></Field></div>
                </>
              )}
            </div>
          )}

          {taskConfigTab === 'review' && (
            <div style={{ paddingTop: 14 }}>
              <ReviewOverridesEditor value={reviewOverrides} onChange={setReviewOverrides} lanes={steps.map((step) => ({ key: step.key, label: step.title, color: step.color }))} startStepKey={startStep || steps[0]?.key} projectId={projectId} />
            </div>
          )}

          <ScheduleRuleEditor value={buildRule()} onChange={rule => {
            setKind(rule.kind)
            setStartDate(rule.start_date || ''); setEndDate(rule.end_date || '')
            if ('run_at' in rule) setAt(rule.run_at)
            if ('time' in rule) setClock(rule.time)
            if ('every' in rule) setIntervalEvery(rule.every)
            if ('weekdays' in rule) setWeekdays(rule.weekdays)
            if ('monthdays' in rule) setMonthday(rule.monthdays[0])
            if ('expression' in rule) setCron(rule.expression)
          }} />
          <div className="schedule-form-grid schedule-form-grid--spaced">
            <Field label={t('schedules.execution')}><Select value={execution} onChange={(event) => setExecution(event.target.value as ProjectSchedule['execution_mode'])}><option value="workflow">{t('schedules.followWorkflow')}</option><option value="immediate">{t('schedules.immediate')}</option><option value="manual">{t('schedules.manual')}</option></Select></Field>
            <Field label={t('schedules.overlap')}><Select value={overlap} onChange={(event) => setOverlap(event.target.value as ProjectSchedule['overlap_policy'])}><option value="skip">{t('schedules.skip')}</option><option value="parallel">{t('schedules.parallel')}</option><option value="queue">{t('schedules.queue')}</option></Select></Field>
          </div>
          <div style={{ marginTop: 14, padding: 12, borderRadius: 8, background: 'var(--surface)', fontSize: 'calc(12px * var(--font-scale))', color: 'var(--fg-2)' }}>
            {preview.cron && <div>Cron: <code>{preview.cron}</code></div>}
            <div style={{ marginTop: 5 }}>{t('schedules.nextRuns')}: {preview.next.slice(0, 3).map(formatDate).join(' · ') || '—'}</div>
          </div>

          <ScheduleNotificationEditor key={`${projectId}:${selectedId || 'new'}`} projectId={projectId} initialValue={selected?.notification}
            onChange={(state, automatic) => { if (automatic) acceptDefaults('notification', state.value); setNotification(state) }} />
          {canManage && <div className="schedule-save-row" style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}><Button variant="primary" loading={saving} disabled={!notification.valid || preview.next.length === 0 || (generation === 'agent' ? !instruction.trim() : !workflowId)} onClick={() => void save()}>{t('common.save')}</Button></div>}
          </>}
          </fieldset>)}
        </main>

        <div className="schedule-split-handle" role="separator" aria-orientation="vertical" tabIndex={0} onPointerDown={(event) => beginDividerDrag(event, 'section')} onKeyDown={dividerKeyDown('section')} />

        <section className="schedule-runs" style={{ overflow: 'hidden', padding: 18, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {(selected || creating) && (testOpen && targetType === 'project' && generation === 'agent' ? (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--border-soft)', borderRadius: 8, overflow: 'hidden', background: 'var(--surface)' }}>
              <div style={{ flex: 1, minHeight: 0 }}>
                <AiTaskCreateChat
                  projectId={projectId}
                  taskTitle={title.trim()}
                  taskDescription=""
                  allowGenerateTitle
                  candidateWorkflowIds={candidateWorkflowIds}
                  initialMessage={instruction.trim()}
                  autoSend
                  onDraft={(draft) => {
                    if (draft.title) setTitle(draft.title)
                  }}
                  onClose={() => closeTest()}
                />
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}><strong style={{ fontSize: 'calc(14px * var(--font-scale))' }}>{t('schedules.runs')}</strong><div style={{ flex: 1 }} /><Select value={runFilter} onChange={(event) => setRunFilter(event.target.value)} style={{ width: 130 }}><option value="all">{t('schedules.all')}</option>{['queued', 'running', 'created', 'succeeded', 'failed', 'skipped', 'stopped'].map((status) => <option key={status} value={status}>{t(`schedules.status_${status}` as any)}</option>)}</Select></div>
              {filteredRuns.length === 0 && <div style={{ color: 'var(--meta)', fontSize: 'calc(13px * var(--font-scale))', padding: 16 }}>{t('schedules.noRuns')}</div>}
              {filteredRuns.map((run) => <div key={run.id} style={{ border: '1px solid var(--border-soft)', borderRadius: 8, padding: 11, marginBottom: 8, fontSize: 'calc(12px * var(--font-scale))' }}><div style={{ display: 'flex', alignItems: 'center' }}><span style={{ color: statusColors[run.status], fontWeight: 600 }}>{t(`schedules.status_${run.status}` as any)}</span><span style={{ flex: 1 }} /><span style={{ color: 'var(--meta)' }}>{formatDate(run.scheduled_for)}</span></div>{run.reason && <div style={{ color: 'var(--danger)', marginTop: 6 }}>{run.reason}</div>}<ScheduleRunNotification canRetry={canManage} projectId={projectId} scheduleId={selectedId || ''} run={run} onRetried={async () => { if (selectedId) setRuns((await scheduleApi.runs(projectId, selectedId)).runs) }} />{run.task_id && <Button size="sm" style={{ marginTop: 7 }} onClick={async () => { if (!project) await fetchTasks(projectId, selected?.workflow_id); setFocusMessageId(run.assistant_message_id || undefined); setTaskId(run.task_id || null) }}>{t('schedules.openTask')}</Button>}</div>)}
            </>
          ))}
        </section>
      </div>
      <ConfirmDialog open={deleteId !== null} title={t('schedules.deleteTitle')} message={t('schedules.deleteMessage')} danger confirmText={t('common.delete')} onCancel={() => setDeleteId(null)} onConfirm={() => { if (!deleteId) return; setSaving(true); scheduleApi.delete(projectId, deleteId).then(() => { setDeleteId(null); setCreating(false); setSelectedId(null); fill(null); return load() }).catch((cause) => setError((cause as Error).message)).finally(() => setSaving(false)) }} />
      {taskId && <><div className="modal-overlay schedule-task-backdrop" onClick={() => setTaskId(null)} /><TaskDetail taskId={taskId} focusMessageId={focusMessageId} project={activeProject ?? undefined} onClose={() => setTaskId(null)} /></>}
    </div>
  )
}
