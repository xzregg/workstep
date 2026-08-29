import Icon from '../components/Icon'
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTaskStore } from '../stores/taskStore'
import { useProjectStore } from '../stores/projectStore'
import { setDetailTaskIds } from '../hooks/useWebSocket'
import { fsApi, scheduleApi, type DirectoryOpener } from '../api/client'
import TaskDetail from './TaskDetail'
import { isTaskCompleted, isTaskNotStarted } from './taskDetailChat'
import Button from '../components/Button'
import ConfirmDialog from '../components/ConfirmDialog'
import EmptyState from '../components/EmptyState'
import Field from '../components/Field'
import Input from '../components/Input'
import DateTimePicker from '../components/DateTimePicker'
import MarkdownEditor from '../components/MarkdownEditor'
import AiTaskCreateChat from '../components/AiTaskCreateChat'
import ReviewOverridesEditor from '../components/ReviewOverridesEditor'
import ProjectShareDialog from '../components/ProjectShareDialog'
import type { TaskDraftResult } from '../stores/taskDraftStore'
import { useI18n, type TFunction, type TKey } from '../i18n'
import { formatDuration, toMilliseconds } from '../utils/datetime'
import { formatTokenTotal } from '../utils/statistics'
import SchedulePage from './SchedulePage'
import { resolveTaskCreationErrors } from '../utils/taskCreationErrors.js'
import { formatScheduledStart, localDateTimeAfter, localDateTimeToIso } from '../utils/scheduledStart'
import { assistantStarterPrompt, backfillEmptyTitle } from '../utils/assistantTitle'
import { useOnboardingStore } from '../stores/onboardingStore'

/* ── Styles ── */
const topbarStyle: React.CSSProperties = {
  height: 48, background: 'var(--bg)',
  borderBottom: '1px solid var(--border-soft)',
  display: 'flex', alignItems: 'center',
  padding: '0 20px', gap: 12, flexShrink: 0,
}

const kanbanStyle: React.CSSProperties = {
  flex: 1, display: 'flex', gap: 0,
  overflowX: 'scroll', overflowY: 'hidden',
  padding: '16px 16px 16px 0',
}

const laneStyle: React.CSSProperties = {
  minWidth: 260, maxWidth: 320, flexShrink: 0,
  background: 'var(--surface)', borderRadius: 'var(--radius-md)',
  display: 'flex', flexDirection: 'column',
  marginRight: 12, overflow: 'hidden',
}

const laneBodyStyle: React.CSSProperties = {
  flex: 1, overflowY: 'auto',
  padding: '4px 10px 10px',
  display: 'flex', flexDirection: 'column', gap: 8,
  minHeight: 120,
}

/* ── Status machine ── */
const STATUS_LABEL_KEYS: Record<string, TKey> = {
  ready: 'status.ready', running: 'status.running', paused: 'status.paused', stopped: 'status.stopped',
  done: 'status.done',
  reviewing: 'status.reviewing', awaiting_review: 'status.awaiting_review',
  retrying: 'status.retrying', rejected: 'status.rejected',
  cancelled: 'status.cancelled',
  rework: 'status.rework', rework_waiting: 'status.rework_waiting',
}

const STATUS_COLORS: Record<string, string> = {
  ready: 'var(--status-ready)',
  running: 'var(--status-running)',
  paused: 'var(--status-paused)',
  stopped: 'var(--status-stopped)',
  done: 'var(--status-done)',
  passed: 'var(--status-done)',
  failed: 'var(--status-failed)',
  reviewing: 'var(--accent)',
  awaiting_review: 'var(--status-paused)',
  retrying: 'var(--warn)',
  rejected: 'var(--status-failed)',
  cancelled: '#d97706',
  rework: 'var(--warn)',
  rework_waiting: 'var(--warn)',
}

/* ── Extract lanes from steps.json ── */
interface Lane { key: string; label: string; color: string }

/* ── Default colors for known stage keys ── */
const STAGE_COLORS: Record<string, string> = {
  req: '#0071e3', ui: '#7c3aed', frontend: '#059669',
  backend: '#d97706', test: '#dc2626', deploy: '#16a34a',
}

const FALLBACK_OPENERS: DirectoryOpener[] = [
  { id: 'file_manager', label: 'file_manager', available: true },
]

function OpenerIcon({ id }: { id: string }) {
  const visual: Record<string, { text: string; bg: string; color: string }> = {
    vscode: { text: '⌁', bg: 'var(--accent-light)', color: '#168bd2' },
    sublime: { text: 'S', bg: '#333', color: '#ff9800' },
    file_manager: { text: '⌂', bg: 'var(--accent-light)', color: '#2684ff' },
    terminal: { text: '>_', bg: '#454545', color: 'var(--accent-fg)' },
    iterm: { text: '$', bg: '#3e2945', color: '#59e391' },
    intellij: { text: 'IJ', bg: '#ef476f', color: 'var(--accent-fg)' },
    pycharm: { text: 'PC', bg: '#32c787', color: 'var(--accent-fg)' },
  }
  const item = visual[id] || visual.file_manager
  return (
    <span style={{
      width: 20, height: 20, borderRadius: 5, flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: item.bg, color: item.color, fontSize: id === 'terminal' ? 8 : 10,
      fontWeight: 700, lineHeight: 1,
    }}>
      {item.text}
    </span>
  )
}

function getLanesFromSteps(steps: any, t: TFunction): Lane[] {
  if (steps?.nodes?.length) {
    return steps.nodes.map((n: any) => {
      const key = n.type || n.key || String(n.id)
      return {
        key,
        label: n.title || n.label || n.type,
        color: n.color || STAGE_COLORS[key] || 'var(--meta)',
      }
    })
  }
  if (steps?.steps?.length) {
    return steps.steps.map((s: any) => ({
      key: s.key || s.id,
      label: s.label || s.name || s.key,
      color: s.color || 'var(--meta)',
    }))
  }
  return [{ key: 'do', label: t('taskList.execute'), color: 'var(--accent)' }]
}

function deriveTaskLane(
  task: { steps?: Array<{ step_key: string; status: string }> },
  lanes: Lane[],
): string {
  const laneKeys = new Set(lanes.map((lane) => lane.key))
  const steps = task.steps || []
  const findLane = (status: string) =>
    steps.find((step) => step.status === status && laneKeys.has(step.step_key))?.step_key

  // Keep this priority aligned with the task detail's "current stage" rule.
  return findLane('reviewing')
    || findLane('awaiting_review')
    || findLane('retrying')
    || findLane('rework_waiting')
    || findLane('rework')
    || findLane('running')
    || findLane('rejected')
    || findLane('failed')
    || findLane('cancelled')
    || findLane('pending')
    || [...steps].reverse().find(
      (step) => laneKeys.has(step.step_key)
        && (step.status === 'passed' || step.status === 'skipped')
    )?.step_key
    || lanes[0]?.key
    || 'do'
}

export default function TaskList() {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const openerDisplayLabel = (opener: DirectoryOpener) =>
    opener.id === 'file_manager' ? t('taskList.openLocation') : opener.label
  const {
    tasks, loading, fetchTasks, createTask, runTask, deleteTask,
    archiveTask, unarchiveTask, setActiveTask,
  } = useTaskStore()
  const activeProject = useProjectStore((s) => s.activeProject)
  const activeWorkflowId = useProjectStore((s) => s.activeWorkflowId)
  const activeWorkflowName = activeProject?.workflows?.find((w) => w.id === activeWorkflowId)?.name
  const [showNewPanel, setShowNewPanel] = useState(false)
  const [createStartStepKey, setCreateStartStepKey] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [confirmDeleteTaskId, setConfirmDeleteTaskId] = useState<string | null>(null)
  const [confirmStartTaskId, setConfirmStartTaskId] = useState<string | null>(null)
  const [confirmArchiveTaskId, setConfirmArchiveTaskId] = useState<string | null>(null)
  const [startingTaskId, setStartingTaskId] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  // Subscribe the daemon to this task's full event stream while its
  // detail panel is open; unsubscribe when closed or navigating away.
  useEffect(() => {
    setDetailTaskIds(selectedTaskId ? [selectedTaskId] : [])
    return () => setDetailTaskIds([])
  }, [selectedTaskId])
  const [scheduleCount, setScheduleCount] = useState(0)
  const [showScheduleDialog, setShowScheduleDialog] = useState(false)
  const [showShareDialog, setShowShareDialog] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [createError, setCreateError] = useState('')
  const [activeTab, setActiveTab] = useState<'content' | 'review'>('content')
  const [newDesc, setNewDesc] = useState('')
  const [newAutoStart, setNewAutoStart] = useState(false)
  const [newStartMode, setNewStartMode] = useState<'manual' | 'immediate' | 'scheduled'>('manual')
  const [newScheduledStart, setNewScheduledStart] = useState('')
  const [dragOverLane, setDragOverLane] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [copiedWorkflowId, setCopiedWorkflowId] = useState(false)
  const [showMemoryPanel, setShowMemoryPanel] = useState(false)
  const [memoryContent, setMemoryContent] = useState('')
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memorySaving, setMemorySaving] = useState(false)
  const [memoryError, setMemoryError] = useState('')
  const [memoryNotice, setMemoryNotice] = useState('')
  const [confirmCloseMemory, setConfirmCloseMemory] = useState(false)
  const [confirmCloseNewTask, setConfirmCloseNewTask] = useState(false)
  const [taskAiOpen, setTaskAiOpen] = useState(false)
  const [taskAiBusy, setTaskAiBusy] = useState(false)
  const [taskAiMessage, setTaskAiMessage] = useState('')
  const [taskAiChatWidth, setTaskAiChatWidth] = useState<number | null>(null)
  const [pendingTaskDraft, setPendingTaskDraft] = useState<TaskDraftResult | null>(null)
  const newTitleInputRef = useRef<HTMLInputElement>(null)
  const memorySavedRef = useRef('')
  const newPanelBaselineRef = useRef<{
    title: string
    desc: string
    autoStart: boolean
    startMode: 'manual' | 'immediate' | 'scheduled'
    scheduledStart: string
    startStepKey: string | null
    overrides: Record<string, { mode: 'skip' | 'auto' | 'manual'; auto: boolean; prompt: string; maxRetries: number }>
  }>({ title: '', desc: '', autoStart: false, startMode: 'manual', scheduledStart: '', startStepKey: null, overrides: {} })
  const [directoryNotice, setDirectoryNotice] = useState('')
  const [directoryOpeners, setDirectoryOpeners] = useState<DirectoryOpener[]>(FALLBACK_OPENERS)
  const [selectedOpener, setSelectedOpener] = useState(
    () => localStorage.getItem('workstep-directory-opener') || 'file_manager'
  )
  const [showOpenerMenu, setShowOpenerMenu] = useState(false)
  const openerMenuRef = useRef<HTMLDivElement>(null)
  // Local lane override for unstarted cards moved manually in the board.
  const [cardLanes, setCardLanes] = useState<Record<string, string>>({})
  const tasksFetchedRef = useRef<string>('')

  useEffect(() => {
    if (!activeProject?.id) { tasksFetchedRef.current = ''; return }
    if (tasksFetchedRef.current === activeProject.id) return
    tasksFetchedRef.current = activeProject.id
    fetchTasks(activeProject.id, activeWorkflowId, showArchived)
  }, [fetchTasks, activeProject?.id, showArchived])

  useEffect(() => {
    if (activeProject?.id) fetchTasks(activeProject.id, activeWorkflowId, showArchived)
  }, [fetchTasks, activeProject?.id, activeWorkflowId, showArchived])

  useEffect(() => {
    let cancelled = false
    const projectId = activeProject?.id

    if (!projectId) {
      setScheduleCount(0)
      return () => {
        cancelled = true
      }
    }

    void scheduleApi
      .list(projectId)
      .then(({ schedules }) => {
        if (!cancelled) setScheduleCount(schedules.length)
      })
      .catch(() => {
        if (!cancelled) setScheduleCount(0)
      })

    return () => {
      cancelled = true
    }
  }, [activeProject?.id])

  // Reset local state when project changes
  useEffect(() => {
    setCardLanes({})
    setShowNewPanel(false)
    setTaskAiOpen(false)
    setTaskAiBusy(false)
    setShowScheduleDialog(false)
    setShowShareDialog(false)
    setCreateStartStepKey(null)
    setShowArchived(false)
  }, [activeProject?.path])

  useEffect(() => {
    fsApi.directoryOpeners()
      .then(({ openers }) => {
        const available = openers.filter((opener) => opener.available)
        setDirectoryOpeners(available.length ? available : FALLBACK_OPENERS)
        if (!available.some((opener) => opener.id === selectedOpener)) {
          setSelectedOpener('file_manager')
          localStorage.setItem('workstep-directory-opener', 'file_manager')
        }
      })
      .catch(() => setDirectoryOpeners(FALLBACK_OPENERS))
  }, [selectedOpener])

  useEffect(() => {
    if (!showOpenerMenu) return
    const closeMenu = (event: MouseEvent) => {
      if (!openerMenuRef.current?.contains(event.target as Node)) {
        setShowOpenerMenu(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowOpenerMenu(false)
    }
    document.addEventListener('mousedown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [showOpenerMenu])

  const lanes = useMemo(() => getLanesFromSteps(activeProject?.steps, t), [activeProject?.steps, t])
  const createLane = lanes.find((lane) => lane.key === createStartStepKey) || lanes[0]
  const createLaneIndex = Math.max(0, lanes.findIndex((lane) => lane.key === createLane?.key))

  const [reviewOverrides, setReviewOverrides] = useState<Record<string, { mode: 'skip' | 'auto' | 'manual'; auto: boolean; prompt: string; maxRetries: number }>>({})

  const openNewPanel = (stepKey?: string) => {
    const selectedStepKey = stepKey || lanes[0]?.key || null
    setCreateStartStepKey(selectedStepKey)
    setNewTitle('')
    setNewDesc('')
    setCreateError('')
    setTaskAiOpen(false)
    setTaskAiBusy(false)
    setTaskAiMessage('')
    setPendingTaskDraft(null)
    setActiveTab('content')
    // Initialize review overrides from canvas stage config
    const nodeConfigs: Record<string, { mode: 'skip' | 'auto' | 'manual'; auto: boolean; prompt: string; maxRetries: number }> = {}
    const canvasSteps = activeProject?.steps
    const selectedStage = [
      ...(canvasSteps?.nodes || []),
      ...(canvasSteps?.steps || []),
    ].find((stage: any) => (
      stage.type || stage.key || String(stage.id)
    ) === selectedStepKey)
    setNewAutoStart(Boolean(selectedStage?.autoStart))
    setNewStartMode(selectedStage?.autoStart ? 'immediate' : 'manual')
    setNewScheduledStart('')
    if (canvasSteps?.nodes) {
      for (const n of canvasSteps.nodes) {
        const key = (n.type || n.key || String(n.id)) as string
        const rv = n.review || {}
        nodeConfigs[key] = {
          mode: ['skip', 'auto', 'manual'].includes(rv.mode)
            ? rv.mode
            : rv.auto
              ? 'auto'
              : 'manual',
          auto: !!rv.auto,
          prompt: String(rv.prompt || ''),
          maxRetries: Math.max(1, Math.min(5, Number(rv.maxRetries) || 1)),
        }
      }
    }
    setReviewOverrides(nodeConfigs)
    newPanelBaselineRef.current = {
      title: '',
      desc: '',
      autoStart: Boolean(selectedStage?.autoStart),
      startMode: selectedStage?.autoStart ? 'immediate' : 'manual',
      scheduledStart: '',
      startStepKey: selectedStepKey,
      overrides: JSON.parse(JSON.stringify(nodeConfigs)),
    }
    setShowNewPanel(true)
  }

  useEffect(() => {
    const command = searchParams.get('onboarding')
    const taskId = searchParams.get('task')
    if (command === 'create-task' && activeProject && activeWorkflowId && lanes.length > 0 && !showNewPanel) {
      openNewPanel()
      const next = new URLSearchParams(searchParams)
      next.delete('onboarding')
      setSearchParams(next, { replace: true })
      return
    }
    if (taskId && activeProject) {
      setActiveTask(taskId)
      setSelectedTaskId(taskId)
      const next = new URLSearchParams(searchParams)
      next.delete('task')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, setSearchParams, activeProject, activeWorkflowId, lanes.length, showNewPanel, setActiveTask]) // eslint-disable-line react-hooks/exhaustive-deps

  // Backend step progress is the source of truth; local assignment is only a
  // temporary override before a task has started executing.
  const getCardLane = useCallback((taskId: string): string => {
    const task = tasks.find((item) => item.id === taskId)
    const hasRecordedProgress = task?.steps.some((step) => step.status !== 'pending')
    if (task && hasRecordedProgress) return deriveTaskLane(task, lanes)
    return cardLanes[taskId]
      || (task ? deriveTaskLane(task, lanes) : lanes[0]?.key || 'do')
  }, [cardLanes, lanes, tasks])

  const visibleTasks = useMemo(
    () => tasks.filter((t) => (showArchived ? t.archived : !t.archived)),
    [tasks, showArchived],
  )

  const tasksByLane = useMemo(() => {
    const map: Record<string, typeof visibleTasks> = {}
    lanes.forEach((l) => { map[l.key] = [] })
    visibleTasks.forEach((t: any) => {
      const lane = getCardLane(t.id)
      if (map[lane]) map[lane].push(t)
      else if (lanes[0]) map[lanes[0].key]?.push(t)
    })
    return map
  }, [visibleTasks, lanes, getCardLane])

  const anyRunning = useMemo(
    () => visibleTasks.some((task: any) => (task.status || 'ready') === 'running'),
    [visibleTasks],
  )
  const [durationNowMs, setDurationNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!anyRunning) return
    setDurationNowMs(Date.now())
    const timer = window.setInterval(() => setDurationNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [anyRunning])

  const handleCreate = async () => {
    if (!newTitle.trim() || !activeProject || taskAiBusy) return
    try {
      const task = await createTask(
        newTitle.trim(),
        activeProject.path,
        activeProject.id,
        newDesc.trim() || undefined,
        createLane?.key,
        Object.keys(reviewOverrides).length > 0 ? reviewOverrides : undefined,
        activeWorkflowId,
        newStartMode === 'immediate',
        newStartMode === 'scheduled' ? localDateTimeToIso(newScheduledStart) : null,
      )
      const onboarding = useOnboardingStore.getState()
      if (
        onboarding.status === 'active'
        && onboarding.currentStep === 'task'
        && onboarding.workflowId === activeWorkflowId
      ) {
        onboarding.recordTask(task.id)
      }
      setNewTitle('')
      setNewDesc('')
      setNewScheduledStart('')
      setShowNewPanel(false)
      setTaskAiOpen(false)
      setCreateError('')
    } catch (e: any) {
      setCreateError(e?.message || t('taskList.createFailed'))
    }
  }

  const requestCloseTaskAi = () => {
    if (taskAiBusy) {
      setConfirmCloseNewTask(true)
      return
    }
    setTaskAiOpen(false)
  }

  const handleStartTaskAi = () => {
    if (taskAiOpen) {
      requestCloseTaskAi()
      return
    }
    setCreateError('')
    setTaskAiMessage(assistantStarterPrompt(
      newTitle,
      (name) => t('taskList.aiCreatePrompt', { name }),
    ))
    setTaskAiOpen(true)
    setActiveTab('content')
  }

  const applyTaskDraft = useCallback((draft: TaskDraftResult) => {
    const targetLane = lanes.find((lane) => lane.key === draft.start_step_key)
    if (!targetLane) {
      setCreateError(t('taskList.aiGenerateFailed'))
      return
    }
    setNewTitle((current) => backfillEmptyTitle(current, draft.title))
    setNewDesc(draft.description)
    setCreateStartStepKey(targetLane.key)
    setPendingTaskDraft(null)
  }, [lanes, t])

  const handleTaskDraft = useCallback((draft: TaskDraftResult) => {
    if (newDesc.trim()) {
      setPendingTaskDraft(draft)
      return
    }
    applyTaskDraft(draft)
  }, [applyTaskDraft, newDesc])

  const startTaskAiDividerDrag = (event: React.MouseEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const panelWidth = Math.min(1100, window.innerWidth * 0.9)
    const startWidth = taskAiChatWidth ?? Math.round((panelWidth * 2) / 5)
    const onMove = (moveEvent: MouseEvent) => {
      setTaskAiChatWidth(Math.max(280, Math.min(panelWidth - 320, startWidth + (startX - moveEvent.clientX))))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const handleSelectTask = (taskId: string) => {
    setActiveTask(taskId)
    setSelectedTaskId(taskId)
  }

  const openProjectDirectory = async (openerId = selectedOpener) => {
    if (!activeProject || activeProject.type === 'remote') return
    try {
      const result = await fsApi.openDirectory(activeProject.path, openerId)
      setDirectoryNotice(t('taskList.opened', { path: result.path }))
    } catch (error) {
      setDirectoryNotice(
        t('taskList.openFailed', { error: error instanceof Error ? error.message : t('common.unknownError') })
      )
    }
    setTimeout(() => setDirectoryNotice(''), 3000)
  }

  const copyWorkflowId = async () => {
    try {
      await navigator.clipboard.writeText(activeWorkflowId || 'default')
      setCopiedWorkflowId(true)
      setTimeout(() => setCopiedWorkflowId(false), 1500)
    } catch {
      // Clipboard unavailable — leave state untouched.
    }
  }

  const openMemoryPanel = async () => {
    setShowMemoryPanel(true)
    setMemoryError('')
    setMemoryNotice('')
    if (!activeProject) return
    setMemoryLoading(true)
    try {
      const result = await fsApi.readMemory(activeProject.id)
      setMemoryContent(result.content)
      memorySavedRef.current = result.content
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : t('taskList.readMemoryFailed'))
    } finally {
      setMemoryLoading(false)
    }
  }

  const handleSaveMemory = async () => {
    if (!activeProject || memorySaving) return
    setMemorySaving(true)
    setMemoryError('')
    setMemoryNotice('')
    try {
      await fsApi.saveMemory(activeProject.id, memoryContent)
      memorySavedRef.current = memoryContent
      setShowMemoryPanel(false)
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : t('taskList.saveMemoryFailed'))
    } finally {
      setMemorySaving(false)
    }
  }

  const closeNewPanel = () => {
    const baseline = newPanelBaselineRef.current
    const dirty = newTitle !== baseline.title
      || newDesc !== baseline.desc
      || newAutoStart !== baseline.autoStart
      || newStartMode !== baseline.startMode
      || newScheduledStart !== baseline.scheduledStart
      || createStartStepKey !== baseline.startStepKey
      || JSON.stringify(reviewOverrides) !== JSON.stringify(baseline.overrides)
    if (dirty || taskAiBusy) {
      setConfirmCloseNewTask(true)
    } else {
      setShowNewPanel(false)
      setTaskAiOpen(false)
    }
  }

  const closeMemoryPanel = () => {
    if (memoryContent !== memorySavedRef.current) {
      setConfirmCloseMemory(true)
    } else {
      setShowMemoryPanel(false)
    }
  }

  const selectDirectoryOpener = (opener: DirectoryOpener) => {
    setSelectedOpener(opener.id)
    localStorage.setItem('workstep-directory-opener', opener.id)
    setShowOpenerMenu(false)
    void openProjectDirectory(opener.id)
  }

  const deleteCard = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation()
    setConfirmDeleteTaskId(taskId)
  }

  const requestStartCard = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation()
    setConfirmStartTaskId(taskId)
  }

  const handleStartConfirm = async () => {
    if (!confirmStartTaskId || !activeProject || startingTaskId) return
    const taskId = confirmStartTaskId
    setConfirmStartTaskId(null)
    setStartingTaskId(taskId)
    try {
      await runTask(taskId, '', activeProject.id)
      await fetchTasks(activeProject.id, activeWorkflowId)
    } catch (error) {
      setDirectoryNotice(
        t('taskList.startFailed', { error: error instanceof Error ? error.message : t('common.unknownError') })
      )
      setTimeout(() => setDirectoryNotice(''), 3000)
    } finally {
      setStartingTaskId(null)
    }
  }

  const handleDeleteConfirm = async () => {
    if (confirmDeleteTaskId && activeProject) {
      await deleteTask(confirmDeleteTaskId, activeProject.id)
      setCardLanes((prev) => { const next = { ...prev }; delete next[confirmDeleteTaskId]; return next })
      setConfirmDeleteTaskId(null)
    }
  }

  const requestArchiveCard = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation()
    setConfirmArchiveTaskId(taskId)
  }

  const handleArchiveConfirm = async () => {
    if (!confirmArchiveTaskId || !activeProject) return
    const taskId = confirmArchiveTaskId
    setConfirmArchiveTaskId(null)
    try {
      await archiveTask(taskId, activeProject.id)
      setCardLanes((prev) => { const next = { ...prev }; delete next[taskId]; return next })
    } catch (error) {
      setDirectoryNotice(
        t('taskList.archiveFailed', { error: error instanceof Error ? error.message : t('common.unknownError') })
      )
      setTimeout(() => setDirectoryNotice(''), 3000)
    }
  }

  const handleUnarchive = async (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation()
    if (!activeProject) return
    try {
      await unarchiveTask(taskId, activeProject.id)
    } catch (error) {
      setDirectoryNotice(
        t('taskList.restoreFailed', { error: error instanceof Error ? error.message : t('common.unknownError') })
      )
      setTimeout(() => setDirectoryNotice(''), 3000)
    }
  }

  // Drag handlers
  const onDragStart = (e: React.DragEvent, taskId: string) => {
    setDragId(taskId);
    (e.currentTarget as HTMLElement).style.opacity = '0.4'
    e.dataTransfer.effectAllowed = 'move'
  }

  const onDragEnd = (e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).style.opacity = '1';
    setDragId(null)
    setDragOverLane(null)
  }

  const onDragOver = (e: React.DragEvent, laneKey: string) => {
    e.preventDefault()
    setDragOverLane(laneKey)
  }

  const onDragLeave = () => { setDragOverLane(null) }

  const onDrop = (e: React.DragEvent, laneKey: string) => {
    e.preventDefault()
    setDragOverLane(null)
    if (dragId) {
      setCardLanes((prev) => ({ ...prev, [dragId]: laneKey }))
    }
    setDragId(null)
  }

  const taskCreationErrors = resolveTaskCreationErrors('', createError)

  return (
    <>
      {/* Topbar */}
      <div style={topbarStyle}>
        <Button
          variant="ghost"
          onClick={() => {
            const params = new URLSearchParams({
              project: activeProject?.name || '',
            })
            if (activeWorkflowId) params.set('workflow', activeWorkflowId)
            navigate(`/canvas?${params.toString()}`)
          }}
          style={{ fontSize: 'calc(13px * var(--font-scale))', gap: 5 }}
        >
          <Icon name="table" size={14} strokeWidth={2} />
          {t('taskList.stageEdit')}
        </Button>
        {!showArchived && (
          <Button variant="primary" onClick={() => openNewPanel()} style={{ fontSize: 'calc(13px * var(--font-scale))', gap: 5 }}>
            <Icon name="plus" size={14} strokeWidth={2.5} />
            {t('taskList.new')}
          </Button>
        )}
        {activeWorkflowName && (
          <span
            title={activeWorkflowName}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 'calc(13px * var(--font-scale))', color: 'var(--fg-2)', fontWeight: 500,
              maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            <Icon name="external-link" size={13} strokeWidth={2} style={{ flexShrink: 0 }} />
            {activeWorkflowName}
          </span>
        )}
        {activeProject && (
          <button
            type="button"
            title={copiedWorkflowId ? t('common.copied') : t('taskList.copyWorkflowIdTitle')}
            aria-label={t('taskList.copyWorkflowIdAria')}
            onClick={() => void copyWorkflowId()}
            style={{
              color: 'var(--meta)', fontSize: 'calc(11px * var(--font-scale))', fontFamily: 'var(--font-mono)',
              whiteSpace: 'nowrap', background: 'none', border: 'none',
              padding: '4px 6px', borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
            }}
          >
            {copiedWorkflowId ? t('common.copied') : `ID: ${activeWorkflowId || 'default'}`}
          </button>
        )}
        <div style={{ flex: 1 }} />
        {directoryNotice && (
          <span
            role="status"
            style={{
              maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap', color: 'var(--meta)', fontSize: 'calc(13px * var(--font-scale))',
            }}
            title={directoryNotice}
          >
            {directoryNotice}
          </span>
        )}
        {activeProject && activeProject.type !== 'remote' && (
          <Button
            variant="ghost"
            onClick={() => setShowShareDialog(true)}
            title={t('layout.remoteShareTitle')}
            style={{ fontSize: 'calc(13px * var(--font-scale))', gap: 5 }}
          >
            <Icon name="share" size={13} strokeWidth={2} />
            {t('layout.remoteShareTitle')}
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => setShowScheduleDialog(true)}
          disabled={!activeProject}
          title={t('schedules.openTitle')}
          style={{ fontSize: 'calc(13px * var(--font-scale))', gap: 5 }}
        >
          <Icon name="clock" size={13} strokeWidth={2} />
          {t('schedules.title')}{scheduleCount > 0 && `(${scheduleCount})`}
        </Button>
        <Button
          variant="ghost"
          onClick={() => void openMemoryPanel()}
          disabled={!activeProject}
          title={t('taskList.memoryButtonTitle')}
          style={{ fontSize: 'calc(13px * var(--font-scale))', gap: 5 }}
        >
          <Icon name="book" size={13} strokeWidth={2} />
          {t('taskList.memory')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => setShowArchived((value) => !value)}
          disabled={!activeProject}
          title={showArchived ? t('canvas.backBoardTitle') : t('taskList.viewArchivedTitle')}
          style={{ fontSize: 'calc(13px * var(--font-scale))', gap: 5 }}
        >
          <Icon name="archive" size={13} strokeWidth={2} />
          {showArchived ? t('taskList.backBoard') : t('taskList.viewArchived')}
        </Button>
        <div ref={openerMenuRef} style={{ display: 'flex', position: 'relative' }}>
          <Button
            variant="ghost"
            onClick={() => void openProjectDirectory()}
            disabled={!activeProject || activeProject.type === 'remote'}
            title={activeProject?.type === 'remote'
              ? t('taskList.remoteNoLocalDirectory')
              : activeProject
              ? t('taskList.openWithTitle', {
                  opener: openerDisplayLabel(
                    directoryOpeners.find((item) => item.id === selectedOpener)
                      ?? { id: 'file_manager', label: '', available: true },
                  ),
                  path: activeProject.path,
                })
              : t('taskList.selectProjectFirst')}
            style={{
              fontSize: 'calc(13px * var(--font-scale))', gap: 6, borderTopRightRadius: 0,
              borderBottomRightRadius: 0, paddingRight: 10,
            }}
          >
            <OpenerIcon id={selectedOpener} />
            {t('taskList.openLocation')}
          </Button>
          <Button
            variant="ghost"
            aria-label={t('taskList.chooseOpener')}
            aria-expanded={showOpenerMenu}
            onClick={() => setShowOpenerMenu((value) => !value)}
            disabled={!activeProject || activeProject.type === 'remote'}
            style={{
              width: 30, padding: 0, justifyContent: 'center',
              borderLeft: 0, borderTopLeftRadius: 0, borderBottomLeftRadius: 0,
            }}
          >
            <Icon name="chevron-down" size={13} strokeWidth={2.2} />
          </Button>
          {showOpenerMenu && (
            <div
              role="menu"
              aria-label={t('taskList.openerMenuAria')}
              style={{
                position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 1200,
                width: 230, padding: 8, background: 'var(--bg)',
                border: '1px solid var(--border)', borderRadius: 14,
                boxShadow: '0 14px 36px rgba(0,0,0,0.16)',
              }}
            >
              {directoryOpeners.map((opener) => (
                <button
                  key={opener.id}
                  role="menuitem"
                  onClick={() => selectDirectoryOpener(opener)}
                  style={{
                    width: '100%', height: 40, padding: '0 10px', gap: 10,
                    justifyContent: 'flex-start', borderRadius: 9,
                    background: opener.id === selectedOpener ? 'var(--surface)' : 'transparent',
                    color: 'var(--fg)', fontSize: 'calc(13px * var(--font-scale))',
                  }}
                >
                  <OpenerIcon id={opener.id} />
                  {openerDisplayLabel(opener)}
                  {opener.id === selectedOpener && (
                    <span style={{ marginLeft: 'auto', color: 'var(--accent)' }}>✓</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Archive-view banner */}
      {showArchived && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
          padding: '8px 20px', fontSize: 'calc(13px * var(--font-scale))', color: 'var(--meta)',
          background: 'color-mix(in oklab, var(--accent), transparent 94%)',
          borderBottom: '1px solid var(--border-soft)',
        }}>
          <Icon name="archive" size={13} strokeWidth={2} />
          {t('taskList.viewingArchived')}
          <span style={{ marginLeft: 'auto', fontSize: 'calc(13px * var(--font-scale))' }}>
            {t('taskList.taskCount', { count: visibleTasks.length })}
          </span>
        </div>
      )}

      {/* Kanban board */}
      <div style={kanbanStyle}>
        {loading && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--meta)' }}>
            {t('common.loading')}
          </div>
        )}

        {!loading && !activeProject && (
          <EmptyState
            className="empty-state-canvas"
            icon={<Icon name="folder" size={48} strokeWidth={1.5} />}
            title={t('taskList.selectProjectEmpty')}
          />
        )}

        {!loading && activeProject && lanes.map((lane) => {
          const laneTasks = tasksByLane[lane.key] || []
          return (
            <div key={lane.key} style={laneStyle}>
              <div style={{ padding: '12px 14px 8px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, fontFamily: 'var(--font-display)', fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: lane.color }} />
                  {lane.label}
                  <span style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 400, color: 'var(--meta)' }}>({laneTasks.length})</span>
                </div>
                {!showArchived && (
                  <Button
                    variant="ghost"
                    aria-label={t('taskList.addTaskToLane', { lane: lane.label })}
                    title={t('taskList.addTaskToLane', { lane: lane.label })}
                    onClick={() => openNewPanel(lane.key)}
                    style={{ marginLeft: 'auto', height: 24, padding: '0 7px', fontSize: 'calc(11px * var(--font-scale))', flexShrink: 0 }}
                  >
                    {t('taskList.add')}
                  </Button>
                )}
              </div>
              <div
                style={{
                  ...laneBodyStyle,
                  background: dragOverLane === lane.key ? 'color-mix(in oklab, var(--accent), transparent 94%)' : 'transparent',
                }}
                onDragOver={(e) => onDragOver(e, lane.key)}
                onDragLeave={onDragLeave}
                onDrop={(e) => onDrop(e, lane.key)}
              >
                {laneTasks.map((task: any) => {
                  const status = task.status || 'ready'
                  const taskNotStarted = isTaskNotStarted(task.steps || [])
                  const taskCompleted = isTaskCompleted(task.steps || [])
                  const isLastLane = lane.key === lanes[lanes.length - 1]?.key
                  const stageStatus = ['reviewing', 'awaiting_review', 'retrying', 'rejected']
                    .find((candidate) =>
                      (task.steps || []).some((step: any) => step.status === candidate)
                    )
                  const displayStatus = taskCompleted ? 'done' : stageStatus || status
                  const statusColor = STATUS_COLORS[displayStatus] || 'var(--status-ready)'
                  const isRunning = status === 'running'
                  const startedMs = toMilliseconds(task.first_message_at)
                  const createdMs = toMilliseconds(task.created_at)
                  let cardDurationMs: number | null = null
                  if (isRunning) {
                    const startMs = startedMs ?? createdMs
                    if (startMs !== null) cardDurationMs = Math.max(0, durationNowMs - startMs)
                  } else if (task.duration_ms != null) {
                    cardDurationMs = task.duration_ms
                  } else if (startedMs !== null) {
                    const endMs = toMilliseconds(task.updated_at) ?? durationNowMs
                    cardDurationMs = Math.max(0, endMs - startedMs)
                  }
                  return (
                    <div
                      key={task.id}
                      data-task-status={status}
                      draggable={!showArchived}
                      onDragStart={(e) => onDragStart(e, task.id)}
                      onDragEnd={onDragEnd}
                      onClick={() => handleSelectTask(task.id)}
                      style={{
                        background: 'var(--bg)', borderRadius: 'var(--radius-sm)',
                        padding: '10px 12px', cursor: 'grab',
                        borderLeft: `3px solid ${statusColor}`,
                        transition: 'box-shadow var(--motion-fast)',
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 6px rgba(0,0,0,0.05)'
                        const actions = e.currentTarget.querySelector('.card-actions') as HTMLElement
                        if (actions) actions.style.opacity = '1'
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.boxShadow = 'none'
                        const actions = e.currentTarget.querySelector('.card-actions') as HTMLElement
                        if (actions) actions.style.opacity = '0'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                        <span
                          title={task.title}
                          style={{
                            fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600, color: 'var(--fg)', flex: 1,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}
                        >
                          {task.title.length > 20 ? task.title.slice(0, 20) + '…' : task.title}
                        </span>
                        {task.scheduled_start_state === 'pending' && task.scheduled_start_at && (
                          <span
                            className="status-badge"
                            title={t('taskList.scheduledStartPending')}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--accent)' }}
                          >
                            <Icon name="clock" size={11} strokeWidth={2} />
                            {formatScheduledStart(task.scheduled_start_at)}
                          </span>
                        )}
                        {task.scheduled_start_state === 'missed' && (
                          <span className="status-badge" title={task.scheduled_start_error || undefined} style={{ color: 'var(--warning)' }}>
                            {t('taskList.scheduledStartMissed')}
                          </span>
                        )}
                        {task.scheduled_start_state === 'failed' && (
                          <span className="status-badge" title={task.scheduled_start_error || undefined} style={{ color: 'var(--danger)' }}>
                            {t('taskList.scheduledStartFailed')}
                          </span>
                        )}
                        <span
                          className="status-badge"
                          data-s={displayStatus}
                          style={stageStatus ? {
                            color: statusColor,
                            background: `color-mix(in oklab, ${statusColor}, transparent 86%)`,
                          } : undefined}
                        >
                          {(displayStatus === 'running' || displayStatus === 'reviewing') && (
                            <span className="task-status-spinner" aria-hidden="true" />
                          )}
                          {t(STATUS_LABEL_KEYS[displayStatus] ?? (displayStatus as TKey))}
                        </span>
                        {status === 'running' && (task.recovered_count || 0) > 0 && (
                          <span
                            title={t('taskList.recoveredTitle', { count: task.recovered_count })}
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 4,
                              fontSize: 'calc(11px * var(--font-scale))', fontWeight: 600, padding: '2px 7px',
                              borderRadius: 'var(--radius-pill)', whiteSpace: 'nowrap',
                              color: 'var(--accent)',
                              background: 'color-mix(in oklab, var(--accent), transparent 88%)',
                              border: '1px solid color-mix(in oklab, var(--accent), transparent 60%)',
                            }}
                          >
                            {t('taskList.recovered')}
                          </span>
                        )}
                      </div>
                      {task.description && (
                        <div style={{
                          display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2,
                          overflow: 'hidden', fontSize: 'calc(13px * var(--font-scale))', color: 'var(--muted)',
                          lineHeight: 1.4, marginBottom: 8,
                        }}>
                          {task.description}
                        </div>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                        <div className="card-actions" style={{ display: 'flex', gap: 2, flex: 1, opacity: 0, transition: 'opacity var(--motion-fast)' }}>
          {taskNotStarted && status !== 'running' && (
            <Button
              variant="icon"
              title={t('taskList.startTask')}
              aria-label={t('taskList.startTask')}
              disabled={startingTaskId === task.id}
              loading={startingTaskId === task.id}
              onClick={(e) => requestStartCard(e, task.id)}
              style={{ width: 22, height: 22, color: 'var(--success)' }}
            >
              ▶️
            </Button>
          )}
          <Button variant="icon" title={t('common.edit')} onClick={(e) => { e.stopPropagation(); handleSelectTask(task.id) }} style={{ width: 22, height: 22 }}>
            <Icon name="pencil" size={12} strokeWidth={2} />
          </Button>
          {!showArchived && taskCompleted && isLastLane && status !== 'running' && (
            <Button
              variant="icon"
              title={t('taskList.archiveTask')}
              aria-label={t('taskList.archiveTask')}
              onClick={(e) => requestArchiveCard(e, task.id)}
              style={{ width: 22, height: 22, color: 'var(--meta)' }}
            >
              <Icon name="archive" size={12} strokeWidth={2} />
            </Button>
          )}
          {showArchived && (
            <Button
              variant="icon"
              title={t('taskList.restoreToBoard')}
              aria-label={t('taskList.restoreToBoard')}
              onClick={(e) => handleUnarchive(e, task.id)}
              style={{ width: 22, height: 22, color: 'var(--success)' }}
            >
              <Icon name="rotate-ccw" size={12} strokeWidth={2} />
            </Button>
          )}
          <div style={{ display: 'flex', gap: 2, marginLeft: 'auto' }}>
            {(task.total_tokens ?? 0) > 0 && (
              <span
                title={t('taskList.tokensTitle')}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)', whiteSpace: 'nowrap',
                }}
              >
                {formatTokenTotal(task.total_tokens as number, locale)} {t('taskList.tokens')}
              </span>
            )}
            {cardDurationMs !== null && cardDurationMs > 0 && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)', whiteSpace: 'nowrap',
              }}>
                <Icon name="clock" size={11} strokeWidth={2} />
                {t('taskList.duration')} {formatDuration(cardDurationMs, t)}
              </span>
            )}
            {!isRunning && (
              <Button variant="icon" title={t('common.delete')} onClick={(e) => deleteCard(e, task.id)} style={{ width: 22, height: 22, color: 'var(--danger)' }}>
                <Icon name="x" size={12} strokeWidth={2} />
              </Button>
            )}
          </div>
                        </div>
                      </div>
                      {status === 'running' && (
                        <div className="card-progress">
                          <span className="card-progress-fill" />
                        </div>
                      )}

                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {/* Backdrop: click outside closes the new-task panel when unchanged */}
      {showNewPanel && (
        <div
          onClick={closeNewPanel}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.2)', zIndex: 999 }}
        />
      )}

      {/* ── New requirement panel (slide-in from right, fixed to viewport) ── */}
      <div style={{
        position: 'fixed', right: 0, top: 0, bottom: 0,
        width: taskAiOpen ? 'min(1100px, 90vw)' : '50vw', minWidth: 420, background: 'var(--bg)',
        borderLeft: '1px solid var(--border-soft)',
        boxShadow: '-4px 0 16px rgba(0,0,0,0.12)',
        display: 'flex', flexDirection: 'column',
        zIndex: 1000,
        transform: showNewPanel ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.3s ease',
      }}>
        <div className="panel-header">
          <span style={{ fontWeight: 600, fontSize: 'calc(13px * var(--font-scale))' }}>{t('taskList.newTaskTitle', { lane: createLane?.label || t('taskList.requirement') })}</span>
          <Button variant="icon" onClick={closeNewPanel} aria-label={t('common.close')}>✕</Button>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* ── Tab bar ── */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border-soft)', padding: '0 16px', gap: 0, flexShrink: 0 }}>
          <button
            onClick={() => setActiveTab('content')}
            style={{
              padding: '10px 16px', fontSize: 'calc(13px * var(--font-scale))', fontWeight: activeTab === 'content' ? 600 : 400,
              border: 'none', borderBottom: activeTab === 'content' ? '2px solid var(--accent)' : '2px solid transparent',
              background: 'none', cursor: 'pointer',
              color: activeTab === 'content' ? 'var(--fg)' : 'var(--meta)',
              fontFamily: 'var(--font-body)',
            }}
          >{t('taskList.contentTab')}</button>
          <button
            onClick={() => setActiveTab('review')}
            style={{
              padding: '10px 16px', fontSize: 'calc(13px * var(--font-scale))', fontWeight: activeTab === 'review' ? 600 : 400,
              border: 'none', borderBottom: activeTab === 'review' ? '2px solid var(--accent)' : '2px solid transparent',
              background: 'none', cursor: 'pointer',
              color: activeTab === 'review' ? 'var(--fg)' : 'var(--meta)',
              fontFamily: 'var(--font-body)',
            }}
          >{t('taskList.reviewTab')}</button>
        </div>

        {/* ── Tab: content ── */}
        {activeTab === 'content' && (
        <div style={{ flex: 1, padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {createLaneIndex > 0 && (
            <div style={{
              marginBottom: 10, padding: '11px 12px', borderRadius: 8,
              background: `color-mix(in oklab, ${createLane?.color || 'var(--accent)'}, transparent 91%)`,
              borderLeft: `3px solid ${createLane?.color || 'var(--accent)'}`,
              color: 'var(--fg-2)', fontSize: 'calc(13px * var(--font-scale))', lineHeight: 1.55,
            }}>
              {t('taskList.startAtStage', { label: createLane?.label })}
              <br />
              {t('taskList.skipPrevious', {
                stages: lanes.slice(0, createLaneIndex)
                  .map((lane) => t('taskList.stageQuote', { label: lane.label }))
                  .join(t('taskList.joinList')),
              })}
            </div>
          )}
          <Field
            label={t('taskList.taskTitle')}
            htmlFor="new-task-title"
            error={taskCreationErrors.titleError || undefined}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <Input
                id="new-task-title"
                ref={newTitleInputRef}
                value={newTitle}
                onChange={(e) => {
                  setNewTitle(e.target.value)
                  setCreateError('')
                }}
                placeholder={t('taskList.titlePlaceholder')}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                style={{ flex: 1, minWidth: 180 }}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={handleStartTaskAi}
                aria-expanded={taskAiOpen}
                title={t('taskList.aiCreateTitle')}
                style={{
                  flexShrink: 0, whiteSpace: 'nowrap', color: 'var(--accent)',
                  border: '1px solid color-mix(in oklab, var(--accent), transparent 55%)',
                  background: 'color-mix(in oklab, var(--accent), transparent 93%)',
                }}
              >
                <Icon name="sparkles" size={13} style={{ marginRight: 4, verticalAlign: -2 }} />
                {t('taskList.aiCreate')}
              </Button>
            </div>
          </Field>
          <label style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500, color: 'var(--muted)', marginTop: 8 }}>{t('taskList.taskDescription')}</label>
          <MarkdownEditor
            value={newDesc}
            onChange={setNewDesc}
            projectId={activeProject?.id}
            placeholder={t('taskList.descPlaceholder', { lane: createLane?.label || t('taskList.currentStage') })}
            minHeight={102}
            showAttachmentHint
          />
          <div style={{ display: 'grid', gridTemplateColumns: newStartMode === 'scheduled' ? '1fr 1fr' : '1fr', gap: 12, marginTop: 8 }}>
            <Field label={t('taskList.startMode')}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', minHeight: 34 }}>
                {([
                  ['manual', t('taskList.startModeManual')],
                  ['immediate', t('taskList.startModeImmediate')],
                  ['scheduled', t('taskList.startModeScheduled')],
                ] as const).map(([mode, label]) => (
                  <label key={mode} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 'calc(13px * var(--font-scale))', whiteSpace: 'nowrap' }}>
                    <input
                      type="radio"
                      name="new-task-start-mode"
                      value={mode}
                      checked={newStartMode === mode}
                      onChange={() => {
                        setNewStartMode(mode)
                        setNewAutoStart(mode === 'immediate')
                        if (mode !== 'scheduled') setNewScheduledStart('')
                      }}
                      style={{ width: 16, height: 16, margin: 0 }}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </Field>
            {newStartMode === 'scheduled' && (
              <Field label={t('taskList.scheduledStart')}>
                <DateTimePicker
                  value={newScheduledStart}
                  min={localDateTimeAfter(1)}
                  onChange={setNewScheduledStart}
                />
              </Field>
            )}
          </div>
        </div>
        )}

        {/* ── Tab: review ── */}
        {activeTab === 'review' && (
        <div style={{ flex: 1, padding: '12px 16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <ReviewOverridesEditor value={reviewOverrides} onChange={setReviewOverrides} lanes={lanes} startStepKey={createLane?.key} projectId={activeProject?.id} />
        </div>
        )}

        {/* ── Error & Footer ── */}
        {taskCreationErrors.panelError && (
          <div style={{ padding: '8px 16px 0', fontSize: 'calc(13px * var(--font-scale))', color: 'var(--danger)' }}>{taskCreationErrors.panelError}</div>
        )}
        <div className="panel-footer">
          <Button variant="ghost" onClick={closeNewPanel}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={taskAiBusy || !newTitle.trim() || (newStartMode === 'scheduled' && !localDateTimeToIso(newScheduledStart))} onClick={handleCreate}>{t('common.create')}</Button>
        </div>
        </div>
        {taskAiOpen && activeProject && (
          <>
            <div
              onMouseDown={startTaskAiDividerDrag}
              title={t('layout.dragResizeChat')}
              style={{
                width: 8, flexShrink: 0, cursor: 'col-resize', position: 'relative',
                background: 'transparent', userSelect: 'none',
              }}
            >
              <div style={{
                position: 'absolute', insetBlock: 0, left: '50%', width: 1,
                transform: 'translateX(-50%)', background: 'var(--border-soft)',
              }} />
            </div>
            <div style={{
              width: taskAiChatWidth ?? '40%', maxWidth: '45vw', minWidth: 280, flexShrink: 0, minHeight: 0,
              display: 'flex', flexDirection: 'column', background: 'var(--bg)',
            }}>
              <AiTaskCreateChat
                projectId={activeProject.id}
                taskTitle={newTitle.trim()}
                taskDescription={newDesc}
                allowGenerateTitle={!newTitle.trim()}
                workflowId={activeWorkflowId || undefined}
                startStepKey={createLane?.key}
                initialMessage={taskAiMessage}
                onDraft={handleTaskDraft}
                onBusyChange={setTaskAiBusy}
                onClose={requestCloseTaskAi}
              />
            </div>
          </>
        )}
        </div>
      </div>

      {/* ── Schedule dialog ── */}
      {showScheduleDialog && (
        <div
          className="modal-overlay"
          role="presentation"
          style={{ zIndex: 1000, padding: 24 }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('schedules.title')}
            style={{ width: 'min(1500px, 96vw)', height: 'min(900px, 92vh)', maxHeight: '92vh' }}
          >
            <SchedulePage
              onClose={() => setShowScheduleDialog(false)}
              onCountChange={setScheduleCount}
            />
          </div>
        </div>
      )}

      <ProjectShareDialog
        project={showShareDialog ? activeProject : null}
        onClose={() => setShowShareDialog(false)}
      />

      {/* ── Task detail slide-in panel from right ── */}
      {selectedTaskId && (
        <>
          {/* Backdrop */}
          <div
            onClick={() => setSelectedTaskId(null)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.2)', zIndex: 999 }}
          />
          <TaskDetail
            taskId={selectedTaskId}
            onClose={() => setSelectedTaskId(null)}
          />
        </>
      )}

      {/* ── Delete confirm dialog ── */}
      <ConfirmDialog
        open={confirmStartTaskId !== null}
        title={t('taskList.startTask')}
        message={t('taskList.startTaskMessage', {
          title: tasks.find((task) => task.id === confirmStartTaskId)?.title || t('taskList.thatTask'),
        })}
        confirmText={t('taskList.start')}
        onConfirm={handleStartConfirm}
        onCancel={() => setConfirmStartTaskId(null)}
      />

      <ConfirmDialog
        open={confirmDeleteTaskId !== null}
        title={t('taskList.deleteTask')}
        message={t('taskList.deleteTaskMessage')}
        confirmText={t('common.delete')}
        danger
        onConfirm={handleDeleteConfirm}
        onCancel={() => setConfirmDeleteTaskId(null)}
      />

      <ConfirmDialog
        open={confirmArchiveTaskId !== null}
        title={t('taskList.archiveTask')}
        message={t('taskList.archiveTaskMessage', {
          title: tasks.find((task) => task.id === confirmArchiveTaskId)?.title || t('taskList.thatTask'),
        })}
        confirmText={t('taskList.archive')}
        onConfirm={handleArchiveConfirm}
        onCancel={() => setConfirmArchiveTaskId(null)}
      />

      <ConfirmDialog
        open={confirmCloseNewTask}
        title={t('taskList.discardNewTitle')}
        message={taskAiBusy ? t('taskList.aiRunningCloseMessage') : t('taskList.discardNewMessage')}
        confirmText={t('taskList.discard')}
        danger
        onConfirm={() => {
          setConfirmCloseNewTask(false)
          setShowNewPanel(false)
          setTaskAiOpen(false)
        }}
        onCancel={() => setConfirmCloseNewTask(false)}
      />

      <ConfirmDialog
        open={pendingTaskDraft !== null}
        title={t('taskList.aiOverwriteTitle')}
        message={t('taskList.aiOverwriteMessage', {
          stage: lanes.find((lane) => lane.key === pendingTaskDraft?.start_step_key)?.label
            || pendingTaskDraft?.start_step_key
            || t('taskList.currentStage'),
        })}
        confirmText={t('taskList.aiApply')}
        onConfirm={() => {
          if (pendingTaskDraft) applyTaskDraft(pendingTaskDraft)
        }}
        onCancel={() => setPendingTaskDraft(null)}
      />

      <ConfirmDialog
        open={confirmCloseMemory}
        title={t('taskList.discardMemoryTitle')}
        message={t('taskList.discardMemoryMessage')}
        confirmText={t('layout.discardChanges')}
        danger
        onConfirm={() => {
          setConfirmCloseMemory(false)
          setShowMemoryPanel(false)
        }}
        onCancel={() => setConfirmCloseMemory(false)}
      />

      {/* Backdrop: click outside closes the memory panel when unchanged */}
      {showMemoryPanel && (
        <div
          onClick={closeMemoryPanel}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.2)', zIndex: 999 }}
        />
      )}

      {/* ── Memory editor panel (slide-in from right) ── */}
      <div style={{
        position: 'fixed', right: 0, top: 0, bottom: 0,
        width: '50vw', minWidth: 420, background: 'var(--bg)',
        borderLeft: '1px solid var(--border-soft)',
        boxShadow: '-4px 0 16px rgba(0,0,0,0.12)',
        display: 'flex', flexDirection: 'column',
        zIndex: 1000,
        transform: showMemoryPanel ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.3s ease',
      }}>
        <div className="panel-header">
          <span style={{ fontWeight: 600, fontSize: 'calc(13px * var(--font-scale))', display: 'flex', alignItems: 'center', gap: 8 }}>
            {t('taskList.editMemory')}
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)', fontWeight: 400 }}>.workstep/MEMORY.md</span>
          </span>
          <Button variant="icon" onClick={closeMemoryPanel} aria-label={t('common.close')}>✕</Button>
        </div>
        {memoryError && (
          <div style={{
            padding: '8px 16px', fontSize: 'calc(13px * var(--font-scale))', color: 'var(--danger)',
            background: 'color-mix(in oklab, var(--danger), transparent 90%)',
          }}>
            {memoryError}
          </div>
        )}
        <div style={{ flex: 1, padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          {memoryLoading ? (
            <div style={{ color: 'var(--meta)', fontSize: 'calc(13px * var(--font-scale))' }}>{t('common.loading')}</div>
          ) : (
            <MarkdownEditor
              value={memoryContent}
              onChange={setMemoryContent}
              projectId={activeProject?.id}
              ariaLabel={t('taskList.projectMemory')}
            />
          )}
        </div>
        <div className="panel-footer" style={{ alignItems: 'center' }}>
          {memoryNotice && (
            <span style={{ color: 'var(--success)', fontSize: 'calc(13px * var(--font-scale))', marginRight: 'auto' }} role="status">
              {memoryNotice}
            </span>
          )}
          <Button variant="ghost" onClick={closeMemoryPanel}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            onClick={() => void handleSaveMemory()}
            disabled={memoryLoading || memorySaving}
            loading={memorySaving}
          >
            {t('taskList.saveMemory')}
          </Button>
        </div>
      </div>
    </>
  )
}
