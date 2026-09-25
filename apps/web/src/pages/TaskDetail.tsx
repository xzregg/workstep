import ResizablePanel from '../components/ResizablePanel'
import { useTaskHistory } from '../hooks/useTaskHistory'
import { gitApi } from '../api/git'
import { useSearchParams } from 'react-router-dom'
import { useTaskRoute } from '../hooks/useTaskRoute'
import { useShallow } from 'zustand/react/shallow'
import { randomUuid } from '../utils/uuid'
import { useOverlay } from '../hooks/useOverlay'
import { useCompactLayout } from '../hooks/useCompactLayout'
import Button from '../components/Button'
import DateTimePicker from '../components/DateTimePicker'
import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type { A2uiClientAction } from '@a2ui/web_core/v0_9'
import { useTaskStore, type LiveMessage } from '../stores/taskStore'
import { useProjectStore } from '../stores/projectStore'
import { publishEngineCatalog } from '../stores/engineAvailabilityStore'
import {
  fsApi,
  projectApi,
  providerApi,
  taskApi,
  type ActionProposal,
  type CoordinatorConfig,
  type ProviderInfo,
  type ReviewRun,
  type TaskArtifact,
  type TaskArtifactInputSnapshot,
  type TaskStepState,
} from '../api/client'
import { copyMessageText } from '../components/MessageResponseFooter'
import { a2uiActionMessageParams } from '../utils/a2ui'
import MarkdownEditor from '../components/MarkdownEditor'
import StepPromptVariablesHint from '../components/StepPromptVariablesHint'
import Icon from '../components/Icon'
import ShareDialog from '../components/ShareDialog'
import ConfirmDialog from '../components/ConfirmDialog'
import TaskDetailPage, { type TaskDetailReadCapabilities } from '../components/TaskDetailPage'
import { resolveMarkdownImageSrc } from '../utils/markdownImages'
import TaskStepConfigController from '../components/TaskStepConfigController'
import {
  createOptimisticCoordinatorMessage,
  createOptimisticUserMessage,
  resolveTaskChatTarget,
  isVisibleLiveExecutionMessage,
  isUnpersistedLiveMessage,
  isTaskCompleted,
  isTaskNotStarted,
  isStepResumableWithMessage,
  isStepActiveForStop,
  resolveStepDisplayStatus,
  mergeRefreshedTaskHistory,
  runningTaskMessageIds,
  findPreferredArtifact,
  findActiveStepIndex,
  findLatestDispatchedTask,
  resolveStepRestartImpact,
} from './taskDetailChat'
import { CUSTOM } from '../utils/agui'
import {
  pendingInsertQueueKey,
  usePendingMessageInsertStore,
} from '../stores/pendingMessageInsertStore'
import { useI18n, type TKey } from '../i18n'
import { formatScheduledStart, localDateTimeAfter, localDateTimeToIso, utcToLocalDateTime } from '../utils/scheduledStart'

const EMPTY_EVENTS: any[] = []
const EMPTY_LIVE_MESSAGES: Record<string, LiveMessage> = {}
const EMPTY_PENDING_INSERTS: never[] = []

type StepVisualState =
  | 'completed'
  | 'current'
  | 'reviewing'
  | 'awaiting_review'
  | 'retrying'
  | 'rework'
  | 'rework_waiting'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'pending'

interface StepData {
  key: string
  label: string
  color: string
  kind?: 'llm' | 'task_dispatch'
  dispatch?: {
    targetProjectId?: string
    targetWorkflowId?: string
    targetStartStepKey?: string
  }
  nodeId?: string | number
  dependsOn?: string[]
  reworkDependsOn?: string[]
  engine?: string
  model?: string
  config?: Record<string, string>
  prompt: string
  inputs: Array<{
    name: string
    type: string
    outputs?: Array<{ name: string; type: string }>
  }>
  outputs: Array<{ name: string; type: string }>
}

interface StepProgress extends Partial<TaskStepState> {
  visualState: StepVisualState
}

interface TaskDetailProps {
  taskId: string
  onClose: () => void
}

interface PanelBounds {
  x: number
  y: number
  width: number
  height: number
}

type ResizeEdge = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const PANEL_BOUNDS_KEY = 'workstep:task-detail-bounds'
const SPLIT_RATIO_KEY = 'workstep:task-detail-split-ratio'
const DEFAULT_SPLIT_RATIO = 1 / 3
const SPLIT_HANDLE_WIDTH = 8
const TASK_HISTORY_PAGE_SIZE = 300
const RESIZE_EDGES: ResizeEdge[] = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw']
const RESIZE_LABEL_KEYS: Record<ResizeEdge, TKey> = {
  n: 'taskDetail.resize.n',
  e: 'taskDetail.resize.e',
  s: 'taskDetail.resize.s',
  w: 'taskDetail.resize.w',
  ne: 'taskDetail.resize.ne',
  nw: 'taskDetail.resize.nw',
  se: 'taskDetail.resize.se',
  sw: 'taskDetail.resize.sw',
}

function panelMinimums() {
  return {
    width: Math.min(640, Math.max(320, window.innerWidth - 24)),
    height: Math.min(420, Math.max(280, window.innerHeight - 24)),
  }
}

function clampPanelBounds(bounds: PanelBounds): PanelBounds {
  const minimums = panelMinimums()
  const width = Math.min(
    window.innerWidth,
    Math.max(minimums.width, bounds.width),
  )
  const height = Math.min(
    window.innerHeight,
    Math.max(minimums.height, bounds.height),
  )
  return {
    width,
    height,
    x: Math.min(Math.max(0, bounds.x), Math.max(0, window.innerWidth - width)),
    y: Math.min(Math.max(0, bounds.y), Math.max(0, window.innerHeight - height)),
  }
}

function initialPanelBounds(): PanelBounds {
  const fallback = clampPanelBounds({
    width: Math.min(1200, window.innerWidth * 0.85),
    height: window.innerHeight,
    x: Math.max(0, window.innerWidth - Math.min(1200, window.innerWidth * 0.85)),
    y: 0,
  })
  try {
    const saved = sessionStorage.getItem(PANEL_BOUNDS_KEY)
    if (!saved) return fallback
    const parsed = JSON.parse(saved) as Partial<PanelBounds>
    if (
      !Number.isFinite(parsed.x)
      || !Number.isFinite(parsed.y)
      || !Number.isFinite(parsed.width)
      || !Number.isFinite(parsed.height)
    ) return fallback
    return window.innerWidth < 1024 ? parsed as PanelBounds : clampPanelBounds(parsed as PanelBounds)
  } catch {
    return fallback
  }
}

function clampSplitRatio(ratio: number, containerWidth: number): number {
  const usableWidth = Math.max(1, containerWidth - SPLIT_HANDLE_WIDTH)
  const minLeft = Math.min(240, usableWidth * 0.45)
  const minRight = Math.min(320, usableWidth * 0.55)
  const minimum = minLeft / usableWidth
  const maximum = Math.max(minimum, (usableWidth - minRight) / usableWidth)
  return Math.min(maximum, Math.max(minimum, ratio))
}

function initialSplitRatio(): number {
  const stored = Number(sessionStorage.getItem(SPLIT_RATIO_KEY))
  return Number.isFinite(stored) && stored > 0 && stored < 1
    ? stored
    : DEFAULT_SPLIT_RATIO
}

function resizePanelBounds(
  start: PanelBounds,
  edge: ResizeEdge,
  deltaX: number,
  deltaY: number,
): PanelBounds {
  const minimums = panelMinimums()
  let { x, y, width, height } = start
  if (edge.includes('w')) {
    const right = start.x + start.width
    x = Math.min(
      Math.max(0, start.x + deltaX),
      right - minimums.width,
    )
    width = right - x
  }
  if (edge.includes('e')) {
    width = Math.min(
      Math.max(minimums.width, start.width + deltaX),
      window.innerWidth - start.x,
    )
  }
  if (edge.includes('n')) {
    const bottom = start.y + start.height
    y = Math.min(
      Math.max(0, start.y + deltaY),
      bottom - minimums.height,
    )
    height = bottom - y
  }
  if (edge.includes('s')) {
    height = Math.min(
      Math.max(minimums.height, start.height + deltaY),
      window.innerHeight - start.y,
    )
  }
  return clampPanelBounds({ x, y, width, height })
}

export default function TaskDetail({ taskId, onClose }: TaskDetailProps) {
  const { t, locale } = useI18n()
  const { openTask } = useTaskRoute()
  const activeProject = useProjectStore((s) => s.activeProject)
  const projects = useProjectStore((s) => s.projects)
  const setActiveProject = useProjectStore((s) => s.setActiveProject)
  const [searchParams] = useSearchParams()
  const urlProjectName = searchParams.get('project')
  // Resolve the project this task belongs to: prefer the URL ?project= hint
  // (set when the task was opened) so the panel stays pinned to the correct
  // project even if global activeProject changes mid-session.
  // When the resolved project IS the active project, use activeProject directly
  // because its `steps` are kept fresh by setActiveWorkflow, while the
  // projects[] entry may hold stale steps from the last fetchProjects.
  const detailProject = useMemo(() => {
    if (urlProjectName) {
      const match = projects.find((p) => p.name === urlProjectName)
      if (match) {
        if (activeProject?.id === match.id) return activeProject
        return match
      }
    }
    return activeProject
  }, [urlProjectName, projects, activeProject])
  const tasks = useTaskStore((s) => s.tasks)
  const events = useTaskStore((s) => (taskId ? s.events[taskId] : undefined) ?? EMPTY_EVENTS)
  const content = useTaskStore((s) => (taskId ? s.content[taskId] : '') ?? '')
  const liveMessages = useTaskStore((s) => (
    taskId ? s.liveMessages[taskId] : undefined
  ) ?? EMPTY_LIVE_MESSAGES)
  const userMessageEvents = useTaskStore((s) => (
    taskId ? (s.userMessageEvents[taskId] ?? 0) : 0
  ))
  const availableCommands = useTaskStore((s) => (
    taskId ? s.availableCommands[taskId] : undefined
  ))
  const updateTaskDescription = useTaskStore((s) => s.updateTaskDescription)
  const fetchTasks = useTaskStore((s) => s.fetchTasks)
  const refreshTask = useTaskStore((s) => s.refreshTask)
  const updateScheduledStart = useTaskStore((s) => s.updateScheduledStart)
  const [scheduledDraft, setScheduledDraft] = useState('')

  const projectId = detailProject?.id || ''
  const ownerFilePreview = useMemo(() => ({
    load: (path: string) => fsApi.preview(path, projectId),
    rawUrl: (path: string) => fsApi.projectFileUrl(path, projectId),
  }), [projectId])
  const ownerAssetUrl = useCallback(
    (src: string) => resolveMarkdownImageSrc(src, projectId),
    [projectId],
  )
  const ownerExecutionReport = useCallback(
    () => taskApi.executionReport(taskId, projectId),
    [taskId, projectId],
  )
  const task = tasks.find((t) => t.id === taskId)
  const taskStatus = task?.status
  const taskNotStarted = isTaskNotStarted(task?.steps || [])
  const taskCompleted = isTaskCompleted(task?.steps || [])
  const sessionIdForStep = (stepKey?: string | null): string | null => {
    if (!stepKey) return null
    const step = (task?.steps || []).find((item) => item.step_key === stepKey)
    return step?.session_id || null
  }
  const reviewEventSignal = useMemo(() => {
    // 实时链路是 AG-UI 事件：审核生命周期信号以 CUSTOM workstep.* 出现，
    // 审核消息内容由后端在持久化后以 channel=review 的消息事件推送。
    const customEvent = [...events].reverse().find((item) =>
      item.type === 'CUSTOM' && (
        item.name === CUSTOM.reviewStatus
        || item.name === CUSTOM.reviewResult
        || item.name === CUSTOM.stepRetrying
      )
    )
    if (customEvent) {
      const value = customEvent.value ?? customEvent.data ?? {}
      return `custom:${customEvent.name}:${value.review_run_id || ''}:${value.status || ''}:${value.attempt || ''}`
    }
    // 审核消息一开始就先补拉一次历史：即使错过了 TEXT_MESSAGE_START，
    // 已落库的「审核中」消息也能出现在任务消息列表里。
    const liveReview = Object.values(liveMessages).find(
      (message) => message.channel === 'review'
        && ['running', 'completed', 'succeeded', 'failed', 'cancelled'].includes(message.status),
    )
    return liveReview
      ? `review-message:${liveReview.id}:${liveReview.status}`
      : ''
  }, [events, liveMessages])
  const [prompt, setPrompt] = useState('')

  useEffect(() => {
    if (!taskId || !projectId) return
    void refreshTask(taskId, projectId).catch(() => undefined)
  }, [projectId, refreshTask, taskId])
  const [running, setRunning] = useState(false)
  const [coordinatorRunning, setCoordinatorRunning] = useState(false)
  const [chatTarget, setChatTarget] = useState<string | 'coordinator'>('coordinator')
  const [chatError, setChatError] = useState('')
  const [stoppingStepKeys, setStoppingStepKeys] = useState<string[]>([])
  const [restartingStepKeys, setRestartingStepKeys] = useState<string[]>([])
  const [retryingFailedMessageIds, setRetryingFailedMessageIds] = useState<string[]>([])
  const [coordinatorStopping, setCoordinatorStopping] = useState(false)
  const [stepResuming, setStepResuming] = useState(false)
  const [resetStep, setResetStep] = useState(false)
  const [pendingStepRestart, setPendingStepRestart] = useState<{
    prompt: string
    targetStep: StepData
    resetSession: boolean
    interruptedSteps: StepData[]
    restartedSteps: StepData[]
    cancelledSteps: StepData[]
  } | null>(null)
  const [editingInsertId, setEditingInsertId] = useState<string | null>(null)
  const [editingInsertContent, setEditingInsertContent] = useState('')
  const [stepInsertSendingIds, setStepInsertSendingIds] = useState<string[]>([])
  const [activeCoordinatorMessageId, setActiveCoordinatorMessageId] = useState<string | null>(null)

  useEffect(() => {
    setResetStep(false)
  }, [chatTarget, taskId])
  const [coordinatorConfig, setCoordinatorConfig] = useState<CoordinatorConfig | null>(null)
  const [coordinatorConfigSaving, setCoordinatorConfigSaving] = useState(false)
  const [coordinatorConfigError, setCoordinatorConfigError] = useState('')
  const [coordinatorConfigNotice, setCoordinatorConfigNotice] = useState('')
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [proposalOverrides, setProposalOverrides] = useState<Record<string, ActionProposal>>({})
  const [viewingPrompt, setViewingPrompt] = useState<string | null>(null)
  const [livePromptOverrides, setLivePromptOverrides] = useState<Record<string, string>>({})
  const [taskIdCopied, setTaskIdCopied] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [durationNowMs, setDurationNowMs] = useState(() => Date.now())
  const [selectedStep, setSelectedStep] = useState(0)
  const selectedStepTaskRef = useRef<string | null>(null)
  const [hasUnreadMessages, setHasUnreadMessages] = useState(false)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLTextAreaElement>(null)
  const shouldFollowMessagesRef = useRef(true)
  const lastProgrammaticScrollTopRef = useRef(0)
  const stepLastMessageRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const pendingStepScrollRef = useRef<string | null>(null)
  const { historyMessages, setHistoryMessages, historyLoading,
    loadOlderHistory, loadMessageEvents } = useTaskHistory({
    taskId, projectId, userMessageEvents, reviewEventSignal,
    chatScrollRef, shouldFollowMessagesRef, lastProgrammaticScrollTopRef,
  })
  const [artifacts, setArtifacts] = useState<TaskArtifact[]>([])
  const [artifactDirectory, setArtifactDirectory] = useState('')
  const [artifactInputSnapshots, setArtifactInputSnapshots] = useState<TaskArtifactInputSnapshot[]>([])
  const [artifactsLoading, setArtifactsLoading] = useState(false)
  const [reviews, setReviews] = useState<ReviewRun[]>([])
  const [reviewActionPending, setReviewActionPending] = useState(false)
  const [pendingReviewCompletion, setPendingReviewCompletion] = useState<
    | { kind: 'review'; review: ReviewRun; stepKey: string }
    | { kind: 'execution'; messageId: string; artifactRound: number }
    | null
  >(null)
  const [reviewComment, setReviewComment] = useState('')
  const [previewArtifact, setPreviewArtifact] = useState<TaskArtifact | null>(null)
  const [artifactNotice, setArtifactNotice] = useState('')
  const [showPromptEditor, setShowPromptEditor] = useState(false)
  const [editReviewMode, setEditReviewMode] = useState<'skip' | 'auto' | 'manual'>('manual')
  const [editReviewRetries, setEditReviewRetries] = useState(1)
  const [editReviewPrompt, setEditReviewPrompt] = useState('')
  const [promptDraft, setPromptDraft] = useState('')
  const [promptSaving, setPromptSaving] = useState(false)
  const [promptSaveError, setPromptSaveError] = useState('')
  const [editingDescription, setEditingDescription] = useState(false)
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [descriptionSaving, setDescriptionSaving] = useState(false)
  const [descriptionError, setDescriptionError] = useState('')
  const compact = useCompactLayout()
  const mobileDialogRef = useRef<HTMLDivElement>(null)
  useOverlay(compact && Boolean(task), onClose, mobileDialogRef, false)
  const [panelBounds, setPanelBounds] = useState(initialPanelBounds)
  const [splitRatio, setSplitRatio] = useState(initialSplitRatio)
  const interactionCleanupRef = useRef<(() => void) | null>(null)
  const persistedMessageIds = useMemo(
    () => new Set(historyMessages.map((message) => String(message.id))),
    [historyMessages],
  )
  const liveExecutionMessages = useMemo(
    () => Object.values(liveMessages).filter(
      (message) => isVisibleLiveExecutionMessage(message)
        && isUnpersistedLiveMessage(message, persistedMessageIds),
    ),
    [liveMessages, persistedMessageIds],
  )
  const missingLivePromptIds = useMemo(
    () => liveExecutionMessages
      .filter((message) => !message.prompt && !livePromptOverrides[message.id])
      .map((message) => message.id)
      .sort(),
    [liveExecutionMessages, livePromptOverrides],
  )

  useEffect(() => {
    if (compact) return
    sessionStorage.setItem(PANEL_BOUNDS_KEY, JSON.stringify(panelBounds))
  }, [panelBounds, compact])

  useEffect(() => {
    if (compact) return
    sessionStorage.setItem(SPLIT_RATIO_KEY, String(splitRatio))
  }, [splitRatio, compact])

  useEffect(() => {
    setSplitRatio((current) => clampSplitRatio(current, panelBounds.width))
  }, [panelBounds.width])

  useEffect(() => {
    const handleViewportResize = () => {
      if (window.innerWidth >= 1024) setPanelBounds((current) => clampPanelBounds(current))
    }
    window.addEventListener('resize', handleViewportResize)
    return () => window.removeEventListener('resize', handleViewportResize)
  }, [])

  useEffect(() => () => interactionCleanupRef.current?.(), [])

  const beginPanelResize = (
    edge: ResizeEdge,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    const startPointer = { x: event.clientX, y: event.clientY }
    const startBounds = panelBounds
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    const cursor = getComputedStyle(event.currentTarget).cursor
    document.body.style.cursor = cursor
    document.body.style.userSelect = ''

    const handleMove = (moveEvent: PointerEvent) => {
      setPanelBounds(resizePanelBounds(
        startBounds,
        edge,
        moveEvent.clientX - startPointer.x,
        moveEvent.clientY - startPointer.y,
      ))
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      interactionCleanupRef.current = null
    }
    interactionCleanupRef.current?.()
    interactionCleanupRef.current = cleanup
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
  }

  const resizeWithKeyboard = (
    edge: ResizeEdge,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const step = event.shiftKey ? 40 : 12
    const deltaX = event.key === 'ArrowLeft'
      ? -step
      : event.key === 'ArrowRight'
        ? step
        : 0
    const deltaY = event.key === 'ArrowUp'
      ? -step
      : event.key === 'ArrowDown'
        ? step
        : 0
    if (deltaX === 0 && deltaY === 0) return
    event.preventDefault()
    setPanelBounds((current) =>
      resizePanelBounds(current, edge, deltaX, deltaY)
    )
  }

  const beginPanelMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button, input, textarea, select, a, .task-detail-title')) {
      return
    }
    event.preventDefault()
    const startPointer = { x: event.clientX, y: event.clientY }
    const startBounds = panelBounds
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'move'
    document.body.style.userSelect = ''

    const handleMove = (moveEvent: PointerEvent) => {
      setPanelBounds(clampPanelBounds({
        ...startBounds,
        x: startBounds.x + moveEvent.clientX - startPointer.x,
        y: startBounds.y + moveEvent.clientY - startPointer.y,
      }))
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      interactionCleanupRef.current = null
    }
    interactionCleanupRef.current?.()
    interactionCleanupRef.current = cleanup
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
  }

  const moveWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 12
    const deltaX = event.key === 'ArrowLeft'
      ? -step
      : event.key === 'ArrowRight'
        ? step
        : 0
    const deltaY = event.key === 'ArrowUp'
      ? -step
      : event.key === 'ArrowDown'
        ? step
        : 0
    if (deltaX === 0 && deltaY === 0) return
    event.preventDefault()
    setPanelBounds((current) => clampPanelBounds({
      ...current,
      x: current.x + deltaX,
      y: current.y + deltaY,
    }))
  }

  useEffect(() => {
    if (!taskId || !projectId || missingLivePromptIds.length === 0) return
    let cancelled = false
    const missingIds = new Set(missingLivePromptIds)
    taskApi.history(taskId, projectId, TASK_HISTORY_PAGE_SIZE, 0)
      .then((response) => {
        if (cancelled) return
        const prompts = Object.fromEntries(
          (response.messages || [])
            .filter((message: any) => missingIds.has(String(message.id)) && message.prompt)
            .map((message: any) => [String(message.id), String(message.prompt)]),
        )
        if (Object.keys(prompts).length > 0) {
          setLivePromptOverrides((current) => ({ ...current, ...prompts }))
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [missingLivePromptIds.join('|'), projectId, taskId])

  useEffect(() => {
    if (!taskId || !projectId) {
      setCoordinatorConfig(null)
      return
    }
    taskApi.coordinatorConfig(taskId, projectId)
      .then((config) => {
        setCoordinatorConfig(config)
        // 协调引擎下拉的可用性改用共享状态：设置页改动后即时跟随。
        publishEngineCatalog(config.available_engines)
        setCoordinatorConfigError('')
      })
      .catch((reason) => setCoordinatorConfigError(
        reason instanceof Error ? reason.message : t('taskDetail.coordinatorEngineLoadFailed'),
      ))
  }, [taskId, projectId, t])

  useEffect(() => {
    let active = true
    if (!projectId) return
    providerApi.list(projectId)
      .then((result) => {
        if (active) setProviders(result.providers.filter((item) => item.enabled))
      })
      .catch(() => { /* provider list is optional for the engine picker */ })
    return () => { active = false }
  }, [projectId])

  useEffect(() => {
    if (!taskId || !projectId) {
      setReviews([])
      return
    }
    taskApi.reviews(taskId, projectId)
      .then((res) => setReviews(res.reviews || []))
      .catch(() => setReviews([]))
  }, [taskId, projectId, task?.updated_at, reviewEventSignal])

  const refreshArtifacts = useCallback((): Promise<TaskArtifact[]> => {
    if (!taskId || !projectId) return Promise.resolve([])
    return taskApi.artifacts(taskId, projectId)
      .then((res) => {
        setArtifacts(res.artifacts || [])
        setArtifactDirectory(res.artifact_directory || '')
        setArtifactInputSnapshots(res.input_snapshots || [])
        return res.artifacts || []
      })
      .catch(() => {
        setArtifacts([])
        setArtifactDirectory('')
        setArtifactInputSnapshots([])
        return []
      })
  }, [taskId, projectId])

  useEffect(() => {
    if (!taskId || !projectId) {
      setArtifacts([])
      setArtifactInputSnapshots([])
      return
    }
    setArtifactsLoading(true)
    refreshArtifacts().finally(() => setArtifactsLoading(false))
  }, [taskId, projectId, task?.steps, refreshArtifacts])

  // Fetch tasks if not already loaded
  useEffect(() => {
    if (tasks.length === 0 && projectId) fetchTasks(projectId)
  }, [tasks.length, fetchTasks, projectId])

  useEffect(() => {
    shouldFollowMessagesRef.current = true
    setHasUnreadMessages(false)
  }, [taskId])

  useEffect(() => {
    if (!activeCoordinatorMessageId) return
    const activeMessage = liveMessages[activeCoordinatorMessageId]
    if (!activeMessage || !['succeeded', 'failed', 'stopped'].includes(activeMessage.status)) return
    setCoordinatorRunning(false)
    setActiveCoordinatorMessageId(null)
    if (taskId && projectId) {
      taskApi.history(taskId, projectId)
        .then((res) => setHistoryMessages((current) => (
          mergeRefreshedTaskHistory(current, res.messages || [])
        )))
        .catch(() => undefined)
    }
  }, [activeCoordinatorMessageId, liveMessages, projectId, taskId])

  useEffect(() => {
    if (historyLoading || !pendingStepScrollRef.current) return
    const stepKey = pendingStepScrollRef.current
    const frame = requestAnimationFrame(() => {
      stepLastMessageRefs.current[stepKey]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
      pendingStepScrollRef.current = null
    })
    return () => cancelAnimationFrame(frame)
  }, [historyLoading, historyMessages])

  useEffect(() => {
    if (taskStatus) setRunning(taskStatus === 'running')
  }, [taskStatus])

  // Get steps from project steps
  const steps = useMemo<StepData[]>(() => {
    const steps = detailProject?.steps
    if (steps?.nodes?.length) {
      const nodes = steps.nodes as any[]
      const keyByNodeId = new Map<string, string>()
      nodes.forEach((node, index) => {
        keyByNodeId.set(
          String(node.id ?? index + 1),
          String(node.type || node.key || node.id || `step-${index + 1}`),
        )
      })
      const dependsByKey = new Map<string, string[]>()
      const reworkDependsByKey = new Map<string, string[]>()
      const rawConnections = Array.isArray(steps.connections)
        ? steps.connections
        : []
      rawConnections.forEach((connection: any) => {
        const fromKey = keyByNodeId.get(String(connection.from))
        const toKey = keyByNodeId.get(String(connection.to))
        if (!fromKey || !toKey || fromKey === toKey) return
        const isDashed = connection.kind === 'dashed'
          || /dashed|rework/.test(String(connection.style || ''))
        const targetMap = isDashed ? reworkDependsByKey : dependsByKey
        targetMap.set(toKey, [...new Set([...(targetMap.get(toKey) ?? []), fromKey])])
      })
      return nodes.map((node: any, index: number) => {
        const key = String(node.type || node.key || node.id || `step-${index + 1}`)
        return {
          key,
          nodeId: node.id ?? index + 1,
          label: node.title || node.label || key,
          color: node.color || 'var(--meta)',
          kind: node.kind === 'task_dispatch' ? 'task_dispatch' : 'llm',
          dispatch: node.dispatch,
          dependsOn: dependsByKey.get(key) ?? [],
          reworkDependsOn: reworkDependsByKey.get(key) ?? [],
          engine: node.engine || '',
          model: node.model || '',
          prompt: node.prompt || '',
          config: node.config || {},
          inputs: (node.inputs || []).map((input: any) => ({
            name: input.name,
            type: input.type,
            outputs: input.outputs || [],
          })),
          outputs: (node.outputs || []).map((output: any) => ({
            name: output.name,
            type: output.type,
          })),
        }
      })
    }
    if (steps?.steps?.length) return steps.steps.map((s: any) => ({
      key: s.key || s.id,
      label: s.label || s.name,
      color: s.color || 'var(--meta)',
      kind: s.kind === 'task_dispatch' ? 'task_dispatch' : 'llm',
      dispatch: s.dispatch,
      dependsOn: s.dependsOn || [],
      reworkDependsOn: s.reworkDependsOn || [],
      engine: s.engine || '',
      model: s.model || '',
      prompt: s.prompt || '',
      config: s.config || {},
      inputs: (s.inputs || []).map((i: any) => ({
        name: i.name || i,
        type: i.type || 'any',
        outputs: i.outputs || [],
      })),
      outputs: (s.outputs || []).map((o: any) => ({
        name: o.name || o,
        type: o.type || 'any',
      })),
    }))
    return [{ key: 'do', label: t('taskList.execute'), color: 'var(--accent)', engine: '', model: '', prompt: '', inputs: [], outputs: [] }]
  }, [detailProject?.steps, t])

  const stepProgress = useMemo<StepProgress[]>(() => {
    const stepByKey = new Map(
      (task?.steps || []).map((step) => [step.step_key, step]),
    )
    const rawStatuses: TaskStepState['status'][] = steps.map((definition: any) => {
      const taskStep = stepByKey.get(definition.key)
      return resolveStepDisplayStatus(
        taskStep?.status || 'pending',
        taskStep?.previous_status,
      ) as TaskStepState['status']
    })
    const activeIndex = findActiveStepIndex(rawStatuses, task?.status)

    return steps.map((definition, index) => {
      const taskStep = stepByKey.get(definition.key)
      const status = rawStatuses[index]
      let visualState: StepVisualState = 'pending'
      if (status === 'passed') visualState = 'completed'
      else if (status === 'reviewing') visualState = 'reviewing'
      else if (status === 'awaiting_review') visualState = 'awaiting_review'
      else if (status === 'retrying') visualState = 'retrying'
      else if (status === 'rework') visualState = 'rework'
      else if (status === 'rework_waiting') visualState = 'rework_waiting'
      else if (status === 'running') visualState = 'current'
      else if (status === 'failed' || status === 'rejected') visualState = 'failed'
      else if (status === 'cancelled') visualState = 'cancelled'
      else if (status === 'skipped') visualState = 'skipped'
      else if (index === activeIndex) visualState = 'current'
      return { ...taskStep, visualState }
    })
  }, [steps, task?.status, task?.steps])

  const activeStepIndex = useMemo(() => {
    const current = stepProgress.findIndex((progress: StepProgress) =>
      ['current', 'reviewing', 'awaiting_review', 'retrying', 'rework', 'rework_waiting'].includes(
        progress.visualState
      )
    )
    if (current >= 0) return current
    const failed = stepProgress.findIndex((progress: StepProgress) =>
      progress.visualState === 'failed'
    )
    if (failed >= 0) return failed
    const restartTarget = steps.findIndex((step) =>
      step.key === task?.restart_from_step_key
    )
    if (restartTarget >= 0) return restartTarget
    for (let index = stepProgress.length - 1; index >= 0; index -= 1) {
      if (stepProgress[index].visualState !== 'pending') return index
    }
    return 0
  }, [stepProgress, steps, task?.restart_from_step_key])

  const currentStep = steps[selectedStep] || steps[0]
  const activeStep = steps[activeStepIndex] || steps[0]
  const executionStepModel = activeStep?.model || task?.model || ''

  useEffect(() => {
    if (!task?.id) return
    if (selectedStepTaskRef.current !== task.id) selectedStepTaskRef.current = task.id
    setSelectedStep(activeStepIndex)
  }, [activeStepIndex, task?.id])

  useEffect(() => {
    const config = (task?.review_overrides || {})[currentStep.key]
    const mode = ['skip', 'auto', 'manual'].includes(config?.mode)
      ? config.mode
      : config?.auto
        ? 'auto'
        : 'manual'
    setEditReviewMode(mode)
    setEditReviewRetries(config?.maxRetries ?? 1)
    setEditReviewPrompt(config?.prompt ?? '')
  }, [currentStep.key, task?.review_overrides])

  const shouldTickDuration = coordinatorRunning
    || Boolean(activeCoordinatorMessageId)
    || taskStatus === 'running' || stepProgress.some(
    (progress) => [
      'reviewing', 'awaiting_review', 'retrying', 'rework', 'rework_waiting',
    ].includes(progress.visualState)
  )

  useEffect(() => {
    if (!shouldTickDuration) return
    setDurationNowMs(Date.now())
    const timer = window.setInterval(() => setDurationNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [shouldTickDuration])

  const runningSteps = useMemo(() => {
    const runningKeys = new Set(
      stepProgress
        .filter((progress) => isStepActiveForStop(progress.status))
        .map((progress) => progress.step_key),
    )
    return steps.filter((step) => runningKeys.has(step.key))
  }, [steps, stepProgress])

  const resumableSteps = useMemo(() => {
    const resumableKeys = new Set(
      stepProgress
        .filter((progress) => (
          isStepResumableWithMessage(progress.status, progress.has_history)
        ))
        .map((progress) => progress.step_key),
    )
    return steps.filter((step) => resumableKeys.has(step.key))
  }, [steps, stepProgress])

  const chatTargetStepKey = chatTarget === 'coordinator' ? null : chatTarget
  const chatTargetStep = chatTargetStepKey !== null
  const targetStep = chatTargetStepKey
    ? (runningSteps.find((step) => step.key === chatTargetStepKey)
      ?? resumableSteps.find((step) => step.key === chatTargetStepKey)
      ?? null)
    : null
  const activeStepRunning = targetStep !== null
    && runningSteps.some((step) => step.key === targetStep.key)
  const runningMessageByChannel = useMemo(
    () => runningTaskMessageIds(historyMessages, liveMessages, targetStep?.key ?? null),
    [historyMessages, liveMessages, targetStep?.key],
  )
  const coordinatorMessageId = coordinatorRunning && activeCoordinatorMessageId
    ? activeCoordinatorMessageId
    : runningMessageByChannel.coordinator || null
  const coordinatorIsRunning = coordinatorRunning || Boolean(coordinatorMessageId)
  const pendingTargetMessageId = chatTarget === 'coordinator'
    ? coordinatorMessageId
    : (activeStepRunning
      ? (stepProgress.some((progress) => (
          progress.step_key === targetStep?.key && progress.status === 'reviewing'
        ))
          ? runningMessageByChannel.review
          : runningMessageByChannel.execution) || null
      : null)
  const pendingQueueKey = projectId && pendingTargetMessageId
    ? pendingInsertQueueKey(projectId, pendingTargetMessageId)
    : ''
  const stepInserts = usePendingMessageInsertStore(
    (state) => state.queues[pendingQueueKey] || EMPTY_PENDING_INSERTS,
  )
  const pendingInsertActions = usePendingMessageInsertStore(useShallow((state) => ({
    load: state.load,
    add: state.add,
    update: state.update,
    remove: state.remove,
    clear: state.clear,
    reorder: state.reorder,
    discard: state.discard,
  })))

  useEffect(() => {
    if (!projectId || !pendingTargetMessageId) return
    void pendingInsertActions.load(projectId, pendingTargetMessageId).catch((reason) => {
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.sendFailed'))
    })
  }, [pendingInsertActions, pendingTargetMessageId, projectId, t])

  useEffect(() => {
    setEditingInsertId(null)
    setEditingInsertContent('')
  }, [pendingTargetMessageId])

  // When a step engine starts, the input switches to the matching step tab
  // for direct insert-into-execution messages; when no step is running the
  // tab stays on a stopped/failed step so a message can re-run it; otherwise
  // it returns to the coordinator. Manual user selection is preserved.
  useEffect(() => {
    setChatTarget((current) => {
      if (runningSteps.length === 0) {
        return resolveTaskChatTarget(
          current,
          [],
          resumableSteps.map((step) => step.key),
        )
      }
      return resolveTaskChatTarget(
        current,
        runningSteps.map((step) => step.key),
        [],
      )
    })
  }, [runningSteps, resumableSteps])

  /** 向当前可恢复步骤发送一条消息并重新执行该步骤（step 模式的新 turn）。 */
  const resumeStepWithPrompt = useCallback(async (
    promptText: string,
    opts?: {
      onErrorRestore?: () => void
      targetStep?: StepData
      resetSession?: boolean
    },
  ): Promise<boolean> => {
    const resumeTarget = opts?.targetStep ?? targetStep
    if (!taskId || !projectId || !resumeTarget) return false
    setChatError('')
    const optimisticId = `pending-${randomUuid()}`
    const optimisticMessage = createOptimisticUserMessage(
      optimisticId,
      promptText,
      resumeTarget.key,
      new Date().toISOString(),
    )
    shouldFollowMessagesRef.current = true
    setHasUnreadMessages(false)
    setHistoryMessages((current) => [...current, optimisticMessage])
    setStepResuming(true)
    try {
      const accepted = await taskApi.resumeStepWithMessage(
        taskId,
        resumeTarget.key,
        promptText,
        projectId,
        Boolean(opts?.resetSession),
      )
      setHistoryMessages((current) => current.map((message) => (
        message.id === optimisticId
          ? {
              ...message,
              id: accepted.message_id,
              run_id: accepted.run_id,
              channel: 'execution',
              run_status: 'completed',
              sequence: accepted.sequence,
              created_at: accepted.created_at || message.created_at,
            }
          : message
      )))
      if (opts?.resetSession) setResetStep(false)
      return true
    } catch (reason) {
      setHistoryMessages((current) => current.filter(
        (message) => message.id !== optimisticId
      ))
      opts?.onErrorRestore?.()
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.sendFailed'))
      return false
    } finally {
      setStepResuming(false)
    }
  }, [taskId, projectId, targetStep, t])

  const handleRun = async (contentOverride?: string) => {
    if (!taskId || !projectId) return
    const submittedPrompt = (contentOverride ?? prompt).trim()
    if (!submittedPrompt) return
    if ((chatTargetStep && activeStepRunning) || (!chatTargetStep && coordinatorIsRunning)) {
      if (!pendingTargetMessageId) return
      setChatError('')
      try {
        await pendingInsertActions.add(projectId, pendingTargetMessageId, submittedPrompt)
        setPrompt('')
      } catch (reason) {
        setChatError(reason instanceof Error ? reason.message : t('taskDetail.sendFailed'))
      }
      return
    }
    // Step mode (Codex-like): while the step runs, sends land in the
    // pending-insert table; after completion the backend merges and runs them.
    // After a manual stop, sending persists the message and re-runs the step.
    if (chatTargetStep) {
      if (stepResuming) return
      if (!targetStep) return
      const impact = resolveStepRestartImpact(
        steps,
        stepProgress,
        targetStep.key,
      )
      if (impact.interrupted.length > 0) {
        setPendingStepRestart({
          prompt: submittedPrompt,
          targetStep,
          resetSession: resetStep,
          interruptedSteps: impact.interrupted,
          restartedSteps: impact.restarted,
          cancelledSteps: impact.cancelled,
        })
        return
      }
      setPrompt('')
      await resumeStepWithPrompt(submittedPrompt, {
        onErrorRestore: () => setPrompt(submittedPrompt),
        resetSession: resetStep,
      })
      return
    }
    shouldFollowMessagesRef.current = true
    const optimisticId = `pending-${randomUuid()}`
    const optimisticMessage = createOptimisticCoordinatorMessage(
      optimisticId,
      submittedPrompt,
      activeStep.key,
      new Date().toISOString(),
    )
    shouldFollowMessagesRef.current = true
    setHasUnreadMessages(false)
    setChatError('')
    setHistoryMessages((current) => [...current, optimisticMessage])
    setPrompt('')
    setCoordinatorRunning(true)
    try {
      const accepted = await taskApi.chat(
        taskId,
        submittedPrompt,
        projectId,
        randomUuid(),
        [],
        resetStep,
      )
      setHistoryMessages((current) => current.map((message) => (
        message.id === optimisticId
          ? {
              ...message,
              id: accepted.user_message_id,
              channel: 'coordinator',
              run_status: 'completed',
            }
          : message
      )))
      setActiveCoordinatorMessageId(accepted.assistant_message_id)
      if (resetStep) setResetStep(false)
    } catch (reason) {
      setHistoryMessages((current) => current.filter(
        (message) => message.id !== optimisticId
      ))
      setPrompt(submittedPrompt)
      setCoordinatorRunning(false)
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.sendFailed'))
    }
  }

  const confirmUpstreamRestart = async () => {
    const pending = pendingStepRestart
    if (!pending || stepResuming) return
    setPrompt('')
    const accepted = await resumeStepWithPrompt(pending.prompt, {
      targetStep: pending.targetStep,
      resetSession: pending.resetSession,
      onErrorRestore: () => setPrompt(pending.prompt),
    })
    if (accepted) setPendingStepRestart(null)
  }

  const handleStopCoordinator = async () => {
    if (!taskId || !projectId || coordinatorStopping) return
    setCoordinatorStopping(true)
    setChatError('')
    try {
      await taskApi.stopCoordinator(taskId, projectId)
      setCoordinatorRunning(false)
      setActiveCoordinatorMessageId(null)
      taskApi.history(taskId, projectId)
        .then((res) => setHistoryMessages((current) => (
          mergeRefreshedTaskHistory(current, res.messages || [])
        )))
        .catch(() => undefined)
    } catch (reason) {
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.stopFailed'))
    } finally {
      setCoordinatorStopping(false)
    }
  }

  const handleStopStep = async (stepKey: string) => {
    if (!taskId || !projectId) return
    if (stoppingStepKeys.includes(stepKey)) return
    setChatError('')
    setStoppingStepKeys((current) => [...current, stepKey])
    try {
      await taskApi.cancelStep(taskId, stepKey, projectId)
    } catch (reason) {
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.stopFailed'))
    } finally {
      setStoppingStepKeys((current) => current.filter((key) => key !== stepKey))
    }
  }

  /** 引擎会话丢失（rollout / session 文件被清理）：清空会话，用同一步骤提示词重跑。 */
  const handleRestartStepWithFreshSession = async (stepKey: string) => {
    if (!taskId || !projectId) return
    if (restartingStepKeys.includes(stepKey)) return
    setChatError('')
    setRestartingStepKeys((current) => [...current, stepKey])
    try {
      await taskApi.restartStepWithFreshSession(taskId, stepKey, projectId)
      shouldFollowMessagesRef.current = true
      await refreshTask(taskId, projectId)
    } catch (reason) {
      setChatError(
        reason instanceof Error ? reason.message : t('taskDetail.lostSessionRestartFailed'),
      )
    } finally {
      setRestartingStepKeys((current) => current.filter((key) => key !== stepKey))
    }
  }

  const handleRetryFailedMessage = async (messageId: string) => {
    if (!taskId || !projectId || retryingFailedMessageIds.includes(messageId)) return
    setChatError('')
    setRetryingFailedMessageIds((current) => [...current, messageId])
    try {
      await taskApi.retryFailedMessage(taskId, messageId, projectId)
      shouldFollowMessagesRef.current = true
      await refreshTask(taskId, projectId)
      const result = await taskApi.history(taskId, projectId)
      setHistoryMessages((current) => mergeRefreshedTaskHistory(current, result.messages || []))
    } catch (reason) {
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.lostSessionRestartFailed'))
    } finally {
      setRetryingFailedMessageIds((current) => current.filter((id) => id !== messageId))
    }
  }

  const handleStepInsertRemove = async (insertId: string) => {
    if (!projectId || !pendingTargetMessageId) return
    try {
      await pendingInsertActions.remove(projectId, pendingTargetMessageId, insertId)
    } catch (reason) {
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.sendFailed'))
    }
  }

  const handleStepInsertEditStart = (insert: { id: string; content: string }) => {
    setEditingInsertId(insert.id)
    setEditingInsertContent(insert.content)
  }

  const handleStepInsertEditSave = async (insertId: string) => {
    const nextContent = editingInsertContent.trim()
    if (!nextContent || !projectId || !pendingTargetMessageId) return
    try {
      await pendingInsertActions.update(
        projectId,
        pendingTargetMessageId,
        insertId,
        nextContent,
      )
      setEditingInsertId(null)
      setEditingInsertContent('')
    } catch (reason) {
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.sendFailed'))
    }
  }

  const handleStepInsertEditCancel = () => {
    setEditingInsertId(null)
    setEditingInsertContent('')
  }

  const sendStepInserts = async (items: Array<{ id: string; content: string }>) => {
    if (!taskId || !projectId || !targetStep || !pendingTargetMessageId) return
    if (!activeStepRunning || items.length === 0) return
    const submitted = items.map((item) => item.content.trim()).filter(Boolean).join('\n\n')
    if (!submitted) return

    const sendingIds = items.map((item) => item.id)
    const optimisticId = `pending-${randomUuid()}`
    const optimisticMessage = createOptimisticUserMessage(
      optimisticId,
      submitted,
      targetStep.key,
      new Date().toISOString(),
    )
    setChatError('')
    setStepInsertSendingIds((current) => [...new Set([...current, ...sendingIds])])
    setHistoryMessages((current) => [...current, optimisticMessage])
    let accepted
    try {
      accepted = await taskApi.sendStepMessage(
        taskId,
        targetStep.key,
        submitted,
        projectId,
        false,
      )
    } catch (reason) {
      setHistoryMessages((current) => current.filter((message) => message.id !== optimisticId))
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.sendFailed'))
      setStepInsertSendingIds((current) => current.filter((id) => !sendingIds.includes(id)))
      return
    }

    setHistoryMessages((current) => current.map((message) => (
      message.id === optimisticId
        ? {
            ...message,
            id: accepted.message_id,
            run_id: accepted.message_id,
            channel: accepted.channel || 'execution',
            run_status: 'running',
            sequence: accepted.sequence,
            created_at: accepted.created_at || message.created_at,
          }
        : message
    )))
    try {
      await Promise.all(items.map((item) => (
        pendingInsertActions.remove(projectId, pendingTargetMessageId, item.id)
      )))
    } catch (reason) {
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.sendFailed'))
    } finally {
      setStepInsertSendingIds((current) => current.filter((id) => !sendingIds.includes(id)))
    }
  }

  const sendCoordinatorInserts = async (items: Array<{ id: string; content: string }>) => {
    if (!taskId || !projectId || !pendingTargetMessageId || items.length === 0) return
    const submitted = items.map((item) => item.content.trim()).filter(Boolean).join('\n\n')
    if (!submitted) return

    const sendingIds = items.map((item) => item.id)
    const optimisticId = `pending-${randomUuid()}`
    const optimisticMessage = createOptimisticCoordinatorMessage(
      optimisticId,
      submitted,
      activeStep.key,
      new Date().toISOString(),
    )
    shouldFollowMessagesRef.current = true
    setHasUnreadMessages(false)
    setChatError('')
    setStepInsertSendingIds((current) => [...new Set([...current, ...sendingIds])])
    setHistoryMessages((current) => [...current, optimisticMessage])
    try {
      const accepted = await taskApi.chat(
        taskId,
        submitted,
        projectId,
        randomUuid(),
        sendingIds,
      )
      pendingInsertActions.discard(projectId, pendingTargetMessageId, sendingIds)
      setHistoryMessages((current) => current.map((message) => (
        message.id === optimisticId
          ? {
              ...message,
              id: accepted.user_message_id,
              channel: 'coordinator',
              run_status: 'completed',
            }
          : message
      )))
      setCoordinatorRunning(true)
      setActiveCoordinatorMessageId(accepted.assistant_message_id)
    } catch (reason) {
      setHistoryMessages((current) => current.filter((message) => message.id !== optimisticId))
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.sendFailed'))
    } finally {
      setStepInsertSendingIds((current) => current.filter((id) => !sendingIds.includes(id)))
    }
  }

  // A2UI protocol: clicks inside rendered UI bubbles (buttons, pickers, ...)
  // arrive as client actions. Relay them to the coordinator as a user message
  // so the model sees what the user selected and can continue the turn.
  const handleA2uiAction = useCallback((action: A2uiClientAction) => {
    if (!taskId || !projectId) return
    const content = t(
      'taskDetail.a2uiActionMessage',
      a2uiActionMessageParams(action),
    )
    const optimisticId = `pending-a2ui-${randomUuid()}`
    const optimisticMessage = createOptimisticCoordinatorMessage(
      optimisticId,
      content,
      activeStep.key,
      new Date().toISOString(),
    )
    shouldFollowMessagesRef.current = true
    setHasUnreadMessages(false)
    setChatError('')
    setHistoryMessages((current) => [...current, optimisticMessage])
    setCoordinatorRunning(true)
    taskApi.chat(taskId, content, projectId, randomUuid())
      .then((accepted) => {
        setHistoryMessages((current) => current.map((message) => (
          message.id === optimisticId
            ? {
                ...message,
                id: accepted.user_message_id,
                channel: 'coordinator',
                run_status: 'completed',
              }
            : message
        )))
        setActiveCoordinatorMessageId(accepted.assistant_message_id)
      })
      .catch((reason) => {
        setHistoryMessages((current) => current.filter(
          (message) => message.id !== optimisticId
        ))
        setCoordinatorRunning(false)
        setChatError(reason instanceof Error ? reason.message : t('taskDetail.sendFailed'))
      })
  }, [taskId, projectId, activeStep, t])

  const handleInteractionRespond = useCallback(async (
    interactionId: string,
    response: Record<string, unknown>,
  ) => {
    await taskApi.respondInteraction(interactionId, response, projectId)
  }, [projectId])

  const handleCoordinatorEngineChange = async (engineId: string) => {
    if (!taskId || !projectId) return
    setCoordinatorConfigSaving(true)
    setCoordinatorConfigError('')
    setCoordinatorConfigNotice('')
    try {
      const selection = await taskApi.updateCoordinatorConfig(
        taskId,
        projectId,
        engineId || null,
        null,
        null,
        null,
        coordinatorConfig?.configured.thinking_effort || null,
        engineId === 'pydantic_ai'
          ? coordinatorConfig?.configured.provider_id || null
          : null,
      )
      setCoordinatorConfig((current) => current
        ? { ...current, ...selection }
        : current
      )
      setCoordinatorConfigNotice(t('taskDetail.coordinatorSaved'))
    } catch (reason) {
      setCoordinatorConfigError(
        reason instanceof Error ? reason.message : t('taskDetail.engineSwitchFailed'),
      )
    } finally {
      setCoordinatorConfigSaving(false)
    }
  }

  const handleCoordinatorProviderChange = async (providerId: string) => {
    if (!taskId || !projectId || !coordinatorConfig) return
    setCoordinatorConfigSaving(true)
    setCoordinatorConfigError('')
    setCoordinatorConfigNotice('')
    try {
      const selection = await taskApi.updateCoordinatorConfig(
        taskId,
        projectId,
        coordinatorConfig.configured.engine || coordinatorConfig.resolved.engine,
        null,
        null,
        null,
        coordinatorConfig.configured.thinking_effort,
        providerId || null,
      )
      setCoordinatorConfig((current) => current
        ? { ...current, ...selection }
        : current
      )
      setCoordinatorConfigNotice(t('taskDetail.coordinatorSaved'))
    } catch (reason) {
      setCoordinatorConfigError(
        reason instanceof Error ? reason.message : t('taskDetail.engineSwitchFailed'),
      )
    } finally {
      setCoordinatorConfigSaving(false)
    }
  }

  const handleCoordinatorModelChange = async (model: string) => {
    if (!taskId || !projectId || !coordinatorConfig) return
    setCoordinatorConfigSaving(true)
    setCoordinatorConfigError('')
    setCoordinatorConfigNotice('')
    try {
      const selection = await taskApi.updateCoordinatorConfig(
        taskId,
        projectId,
        coordinatorConfig.configured.engine || coordinatorConfig.resolved.engine,
        model || null,
        coordinatorConfig.configured.fast_model,
        coordinatorConfig.configured.vision_model,
        coordinatorConfig.configured.thinking_effort,
        coordinatorConfig.configured.provider_id || null,
      )
      setCoordinatorConfig((current) => current
        ? { ...current, ...selection }
        : current
      )
      setCoordinatorConfigNotice(t('taskDetail.coordinatorSaved'))
    } catch (reason) {
      setCoordinatorConfigError(
        reason instanceof Error ? reason.message : t('taskDetail.modelSwitchFailed'),
      )
    } finally {
      setCoordinatorConfigSaving(false)
    }
  }

  const handleCoordinatorFastModelChange = async (fastModel: string) => {
    if (!taskId || !projectId || !coordinatorConfig) return
    setCoordinatorConfigSaving(true)
    setCoordinatorConfigError('')
    setCoordinatorConfigNotice('')
    try {
      const selection = await taskApi.updateCoordinatorConfig(
        taskId,
        projectId,
        coordinatorConfig.configured.engine || coordinatorConfig.resolved.engine,
        coordinatorConfig.configured.model,
        fastModel || null,
        coordinatorConfig.configured.vision_model,
        coordinatorConfig.configured.thinking_effort,
        coordinatorConfig.configured.provider_id || null,
      )
      setCoordinatorConfig((current) => current
        ? { ...current, ...selection }
        : current
      )
      setCoordinatorConfigNotice(t('taskDetail.coordinatorSaved'))
    } catch (reason) {
      setCoordinatorConfigError(
        reason instanceof Error ? reason.message : t('taskDetail.fastModelSwitchFailed'),
      )
    } finally {
      setCoordinatorConfigSaving(false)
    }
  }

  const handleCoordinatorVisionModelChange = async (visionModel: string) => {
    if (!taskId || !projectId || !coordinatorConfig) return
    setCoordinatorConfigSaving(true)
    setCoordinatorConfigError('')
    setCoordinatorConfigNotice('')
    try {
      const selection = await taskApi.updateCoordinatorConfig(
        taskId,
        projectId,
        coordinatorConfig.configured.engine || coordinatorConfig.resolved.engine,
        coordinatorConfig.configured.model,
        coordinatorConfig.configured.fast_model,
        visionModel || null,
        coordinatorConfig.configured.thinking_effort,
        coordinatorConfig.configured.provider_id || null,
      )
      setCoordinatorConfig((current) => current
        ? { ...current, ...selection }
        : current
      )
      setCoordinatorConfigNotice(t('taskDetail.coordinatorSaved'))
    } catch (reason) {
      setCoordinatorConfigError(
        reason instanceof Error ? reason.message : t('taskDetail.visionModelSwitchFailed'),
      )
    } finally {
      setCoordinatorConfigSaving(false)
    }
  }

  const handleCoordinatorThinkingEffortChange = async (thinkingEffort: string) => {
    if (!taskId || !projectId || !coordinatorConfig) return
    setCoordinatorConfigSaving(true)
    setCoordinatorConfigError('')
    setCoordinatorConfigNotice('')
    try {
      const selection = await taskApi.updateCoordinatorConfig(
        taskId,
        projectId,
        coordinatorConfig.configured.engine || coordinatorConfig.resolved.engine,
        coordinatorConfig.configured.model,
        coordinatorConfig.configured.fast_model,
        coordinatorConfig.configured.vision_model,
        thinkingEffort || null,
        coordinatorConfig.configured.provider_id || null,
      )
      setCoordinatorConfig((current) => current
        ? { ...current, ...selection }
        : current
      )
      setCoordinatorConfigNotice(t('taskDetail.coordinatorSaved'))
    } catch (reason) {
      setCoordinatorConfigError(
        reason instanceof Error ? reason.message : t('taskDetail.effortSwitchFailed'),
      )
    } finally {
      setCoordinatorConfigSaving(false)
    }
  }

  const scheduleInputValue = scheduledDraft || utcToLocalDateTime(task?.scheduled_start_at)
  if (!task) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--meta)' }}>
        {t('taskDetail.taskNotFound')}
        <br />
        <Button variant="ghost" style={{ marginTop: 12 }} onClick={onClose}>← {t('common.back')}</Button>
      </div>
    )
  }

  const currentStepColor = currentStep.color || 'var(--accent)'
  const activeStepColor = activeStep.color || 'var(--accent)'
  const selectedReview = reviews.find((review) => review.step_key === currentStep.key)

  const openDescriptionEditor = () => {
    setDescriptionDraft(task.description || '')
    setScheduledDraft('')
    setDescriptionError('')
    setEditingDescription(true)
  }

  const saveDescription = async () => {
    if (!projectId) return
    setDescriptionSaving(true)
    setDescriptionError('')
    try {
      await updateTaskDescription(task.id, descriptionDraft, projectId)
      if (scheduledDraft) {
        const scheduledStartAt = localDateTimeToIso(scheduledDraft)
        if (scheduledStartAt) {
          await updateScheduledStart(task.id, scheduledStartAt, projectId)
        }
      }
      setScheduledDraft('')
      setEditingDescription(false)
    } catch (error) {
      setDescriptionError(
        error instanceof Error ? error.message : t('taskDetail.descriptionSaveFailed')
      )
    } finally {
      setDescriptionSaving(false)
    }
  }

  const openPromptEditor = () => {
    setPromptDraft(currentStep.prompt)
    setPromptSaveError('')
    setShowPromptEditor(true)
  }

  const saveStepPrompt = async () => {
    if (!detailProject) return
    const currentSteps = detailProject.steps
    let nextSteps = currentSteps
    if (currentSteps?.nodes?.length) {
      nextSteps = {
        ...currentSteps,
        nodes: currentSteps.nodes.map((node: any) =>
          (node.type || node.key) === currentStep.key
            ? { ...node, prompt: promptDraft }
            : node
        ),
      }
    } else if (currentSteps?.steps?.length) {
      nextSteps = {
        ...currentSteps,
        steps: currentSteps.steps.map((step: any) =>
          (step.key || step.id) === currentStep.key
            ? { ...step, prompt: promptDraft }
            : step
        ),
      }
    }

    setPromptSaving(true)
    setPromptSaveError('')
    try {
      await projectApi.saveSteps(detailProject.id, nextSteps)
      setActiveProject({ ...detailProject, steps: nextSteps })
      setShowPromptEditor(false)
    } catch (error) {
      setPromptSaveError(
        t('taskDetail.saveFailed', { error: error instanceof Error ? error.message : t('common.unknownError') })
      )
    } finally {
      setPromptSaving(false)
    }
  }

  const handleStepClick = async (stepIndex: number) => {
    const clickedStep = steps[stepIndex]
    if (clickedStep?.kind === 'task_dispatch') {
      const targetProjectId = clickedStep.dispatch?.targetProjectId
      const targetWorkflowId = clickedStep.dispatch?.targetWorkflowId
      if (targetProjectId && targetWorkflowId) {
        try {
          const result = await taskApi.list(targetProjectId, targetWorkflowId)
          const dispatchedTask = findLatestDispatchedTask(
            result.tasks,
            taskId,
            clickedStep.key,
          )
          if (dispatchedTask) {
            const targetProject = projects.find((project) => project.id === targetProjectId)
            openTask(dispatchedTask.id, targetProject?.name, targetWorkflowId)
            return
          }
        } catch (error) {
          setChatError(
            error instanceof Error ? error.message : t('common.unknownError'),
          )
        }
      }
    }

    setSelectedStep(stepIndex)
    const stepKey = steps[stepIndex]?.key
    if (!stepKey) return

    pendingStepScrollRef.current = stepKey
    if (historyLoading) return

    requestAnimationFrame(() => {
      stepLastMessageRefs.current[stepKey]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
      pendingStepScrollRef.current = null
    })
  }

  const decideReview = async (
    decision: 'approve' | 'reject' | 'force-approve' | 'terminate' | 'complete-task' | 'set-complete',
    review = selectedReview,
    stepKey = currentStep.key,
    scheduleDownstream?: boolean,
  ) => {
    if (!review || !projectId) return
    if (decision === 'set-complete' && scheduleDownstream === undefined) {
      setPendingReviewCompletion({ kind: 'review', review, stepKey })
      return
    }
    setReviewActionPending(true)
    try {
      await taskApi.decideReview(
        task.id,
        stepKey,
        review.id,
        decision,
        projectId,
        reviewComment.trim() || undefined,
        scheduleDownstream,
      )
      setReviewComment('')
      const [reviewResult] = await Promise.all([
        taskApi.reviews(task.id, projectId),
        fetchTasks(projectId),
        refreshTask(task.id, projectId),
      ])
      setReviews(reviewResult.reviews || [])
    } catch (reason) {
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.reviewActionFailed'))
    } finally {
      setReviewActionPending(false)
      setPendingReviewCompletion(null)
    }
  }

  const completeFailedExecution = async (
    messageId: string, artifactRound: number, scheduleDownstream: boolean,
  ) => {
    if (!projectId) return
    setReviewActionPending(true)
    try {
      await taskApi.completeFailedMessage(
        task.id, messageId, artifactRound, scheduleDownstream, projectId,
      )
      await Promise.all([fetchTasks(projectId), refreshTask(task.id, projectId)])
    } catch (reason) {
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.reviewActionFailed'))
    } finally {
      setReviewActionPending(false)
      setPendingReviewCompletion(null)
    }
  }

  const findArtifact = (
    name: string,
    preferredStepKey?: string,
    source?: TaskArtifact[],
    round?: number,
    path?: string,
  ) => {
    return findPreferredArtifact(source || artifacts, name, preferredStepKey, round, path)
  }

  const openArtifact = (
    name: string,
    preferredStepKey?: string,
    round?: number,
    path?: string,
  ) => {
    if (artifactsLoading && artifacts.length === 0) {
      setArtifactNotice(t('taskDetail.artifactLoading'))
    } else {
      const artifact = findArtifact(name, preferredStepKey, undefined, round, path)
      if (artifact) {
        setPreviewArtifact(artifact)
        setArtifactNotice('')
        return
      }
      // 步骤可能刚执行完、产物列表尚未刷新：重新拉取一次再尝试打开。
      setArtifactNotice(t('taskDetail.artifactLoading'))
      refreshArtifacts().then((fresh) => {
        const latest = findArtifact(name, preferredStepKey, fresh, round, path)
        if (latest) {
          setPreviewArtifact(latest)
          setArtifactNotice('')
        } else {
          setArtifactNotice(t('taskDetail.artifactNotFound', { name }))
        }
      })
    }
    setTimeout(() => setArtifactNotice(''), 3000)
  }

  const openArtifactDirectory = async () => {
    if (!previewArtifact || detailProject?.type === 'remote') return
    try {
      const result = await fsApi.openDirectory(previewArtifact.path)
      setArtifactNotice(t('taskDetail.directoryOpened', { path: result.path }))
    } catch (error) {
      setArtifactNotice(
        t('taskDetail.directoryOpenFailed', { error: error instanceof Error ? error.message : t('common.unknownError') })
      )
    }
    setTimeout(() => setArtifactNotice(''), 3000)
  }

  return (
    <div
      ref={mobileDialogRef}
      className="task-detail-window"
      role="dialog"
      aria-modal="true"
      aria-label={t('taskDetail.dialogAria', { title: task.title })}
      style={{
      position: 'fixed',
      left: panelBounds.x,
      top: panelBounds.y,
      width: panelBounds.width,
      height: panelBounds.height,
      background: 'var(--bg)',
      boxShadow: '-4px 0 24px rgba(0,0,0,0.12)',
      display: 'flex', flexDirection: 'column',
      zIndex: 1000,
      animation: 'slideInRight 0.3s ease',
    }}>
      {!compact && RESIZE_EDGES.map((edge) => (
        <div
          key={edge}
          role="separator"
          tabIndex={0}
          aria-label={t(RESIZE_LABEL_KEYS[edge])}
          className={`task-detail-resize-handle task-detail-resize-${edge}`}
          onPointerDown={(event) => beginPanelResize(edge, event)}
          onKeyDown={(event) => resizeWithKeyboard(edge, event)}
        />
      ))}

      <TaskStepConfigController
        projectId={projectId || ''}
        taskId={task.id}
        stepKey={chatTargetStepKey}
        running={activeStepRunning}
      >
        {({ inputConfig: stepEngineConfig, loading: stepEngineConfigLoading, error: stepEngineConfigError }) => <TaskDetailPage
        task={task}
        gitCapability={projectId && detailProject?.type !== 'remote' ? { api: gitApi, projectId } : undefined}
        steps={steps}
        workflowConnections={detailProject?.steps?.connections || []}
        stepProgress={stepProgress}
        selectedStep={selectedStep}
        onStepClick={handleStepClick}
        historyMessages={historyMessages}
        onLoadOlderHistory={loadOlderHistory}
        readCapabilities={{
          artifactDirectory,
          resolveAssetUrl: ownerAssetUrl,
          filePreview: ownerFilePreview,
          loadMessageEvents,
          openArtifact,
          loadExecutionReport: ownerExecutionReport,
        } satisfies TaskDetailReadCapabilities}
        liveMessages={liveMessages}
        livePromptOverrides={livePromptOverrides}
        availableCommands={availableCommands}
        events={events}
        content={content}
        reviews={reviews}
        reviewActionPending={reviewActionPending}
        reviewComment={reviewComment}
        onReviewCommentChange={setReviewComment}
        onReviewAction={decideReview}
        artifacts={artifacts}
        artifactInputSnapshots={artifactInputSnapshots}
        chatTarget={chatTarget}
        onChatTargetChange={setChatTarget}
        coordinatorRunning={coordinatorIsRunning}
        coordinatorConfig={coordinatorConfig}
        stepEngineConfig={stepEngineConfig}
        stepEngineConfigLoading={stepEngineConfigLoading}
        stepEngineConfigError={stepEngineConfigError}
        chatError={chatError}
        onChatError={setChatError}
        prompt={prompt}
        onPromptChange={setPrompt}
        onSend={handleRun}
        onSendPrompt={(value) => { void handleRun(value) }}
        onActionChanged={() => {
          if (!taskId || !projectId) return
          void taskApi.history(taskId, projectId).then((res) => setHistoryMessages((current) => (
            mergeRefreshedTaskHistory(current, res.messages || [])
          )))
        }}
        onStop={chatTarget !== 'coordinator' && activeStepRunning
          ? () => void handleStopStep(chatTarget)
          : handleStopCoordinator}
        stoppingStepKeys={stoppingStepKeys}
        stepResuming={stepResuming}
        resetStep={resetStep}
        onResetStepChange={setResetStep}
        onStopStep={handleStopStep}
        onRestartStepWithFreshSession={handleRestartStepWithFreshSession}
        restartingStepKeys={restartingStepKeys}
        onRetryFailedMessage={handleRetryFailedMessage}
        onSetFailedExecutionComplete={(messageId, artifactRound) => {
          setPendingReviewCompletion({ kind: 'execution', messageId, artifactRound })
        }}
        retryingFailedMessageIds={retryingFailedMessageIds}
        chatInputRef={chatInputRef}
        stepInserts={stepInserts}
        stepInsertSendingIds={stepInsertSendingIds}
        onStepInsertSend={(insert) => {
          if (chatTarget === 'coordinator') void sendCoordinatorInserts([insert])
          else void sendStepInserts([insert])
        }}
        onSendAllInserts={() => {
          if (chatTarget === 'coordinator') void sendCoordinatorInserts(stepInserts)
          else void sendStepInserts(stepInserts)
        }}
        onStepInsertRemove={(insertId) => void handleStepInsertRemove(insertId)}
        onStepInsertEditStart={handleStepInsertEditStart}
        onStepInsertEditSave={(insertId) => void handleStepInsertEditSave(insertId)}
        onStepInsertEditCancel={handleStepInsertEditCancel}
        editingInsertId={editingInsertId}
        editingInsertContent={editingInsertContent}
        onEditingInsertContentChange={setEditingInsertContent}
        onClearInserts={() => {
          if (!projectId || !pendingTargetMessageId) return
          void pendingInsertActions.clear(projectId, pendingTargetMessageId).catch((reason) => {
            setChatError(reason instanceof Error ? reason.message : t('taskDetail.sendFailed'))
          })
        }}
        onStepInsertReorder={(fromIndex, toIndex) => {
          if (!projectId || !pendingTargetMessageId) return
          void pendingInsertActions.reorder(
            projectId,
            pendingTargetMessageId,
            fromIndex,
            toIndex,
          ).catch((reason) => {
            setChatError(reason instanceof Error ? reason.message : t('taskDetail.sendFailed'))
          })
        }}
        onCoordinatorEngineChange={handleCoordinatorEngineChange}
        onCoordinatorProviderChange={handleCoordinatorProviderChange}
        providers={providers}
        onCoordinatorModelChange={handleCoordinatorModelChange}
        onCoordinatorFastModelChange={handleCoordinatorFastModelChange}
        onCoordinatorVisionModelChange={handleCoordinatorVisionModelChange}
        onCoordinatorThinkingEffortChange={handleCoordinatorThinkingEffortChange}
        coordinatorConfigSaving={coordinatorConfigSaving}
        coordinatorConfigError={coordinatorConfigError}
        coordinatorConfigNotice={coordinatorConfigNotice}
        coordinatorStopping={coordinatorStopping}
        editingDescription={editingDescription}
        descriptionDraft={descriptionDraft}
        onDescriptionDraftChange={setDescriptionDraft}
        descriptionSaving={descriptionSaving}
        descriptionError={descriptionError}
        onSaveDescription={saveDescription}
        onCancelDescriptionEdit={() => {
          setScheduledDraft('')
          setEditingDescription(false)
        }}
        onOpenDescriptionEditor={openDescriptionEditor}
        scheduledStartText={formatScheduledStart(task.scheduled_start_at)}
        descriptionEditorLeadingActions={editingDescription && task.scheduled_start_state && taskNotStarted ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: 380, maxWidth: '100%' }}>
            <span
              style={{
                fontSize: 'calc(12px * var(--font-scale))',
                fontWeight: 600,
                color: task.scheduled_start_state === 'pending'
                  ? 'var(--accent)'
                  : task.scheduled_start_state === 'failed'
                    ? 'var(--danger)'
                    : 'var(--warning)',
              }}
            >
              {task.scheduled_start_state === 'pending'
                ? '定时启动'
                : task.scheduled_start_state === 'failed'
                  ? '启动失败'
                  : '已错过'}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <DateTimePicker
                value={scheduleInputValue}
                min={localDateTimeAfter(1)}
                onChange={setScheduledDraft}
                disabled={descriptionSaving}
              />
            </div>
          </div>
        ) : undefined}
        onOpenPromptEditor={openPromptEditor}
        editReviewMode={editReviewMode}
        onEditReviewModeChange={(value) => setEditReviewMode(value as 'skip' | 'auto' | 'manual')}
        editReviewRetries={editReviewRetries}
        onEditReviewRetriesChange={setEditReviewRetries}
        editReviewPrompt={editReviewPrompt}
        onEditReviewPromptChange={setEditReviewPrompt}
        onSaveReviewConfig={async () => {
          const updated = {
            ...(task.review_overrides || {}),
            [currentStep.key]: {
              mode: editReviewMode,
              auto: editReviewMode === 'auto',
              maxRetries: editReviewRetries,
              prompt: editReviewPrompt,
            },
          }
          await updateTaskDescription(task.id, undefined, projectId!, updated)
        }}
        onA2uiAction={handleA2uiAction}
        onInteractionRespond={handleInteractionRespond}
        proposalOverrides={proposalOverrides}
        onProposalOverride={(updated) => {
          setProposalOverrides((current) => ({ ...current, [updated.id]: updated }))
          if (!taskId || !projectId) return
          void taskApi.history(taskId, projectId).then((res) => setHistoryMessages((current) => (
            mergeRefreshedTaskHistory(current, res.messages || [])
          ))).catch(() => undefined)
        }}
        headerActions={
          <>
            <Button
              className="task-detail-share-button"
              variant="ghost"
              title={t('taskDetail.shareButtonTitle')}
              aria-label={t('taskDetail.shareButtonTitle')}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                setShareOpen(true)
              }}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                minHeight: 22, padding: '0 7px', fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)',
                marginLeft: 'auto', order: 98,
              }}
            >
              <Icon name="share" size={13} strokeWidth={1.75} />
              {t('share.dialogTitle')}
            </Button>
            <Button
              className="task-detail-id-button"
              variant="ghost"
              title={t('taskDetail.copyTaskIdTitle')}
              aria-label={t('taskDetail.copyTaskIdAria')}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={async () => {
                await copyMessageText(task.id)
                setTaskIdCopied(true)
                window.setTimeout(() => setTaskIdCopied(false), 1500)
              }}
              style={{
                fontFamily: 'var(--font-mono)', fontSize: 'calc(11px * var(--font-scale))',
                color: taskIdCopied ? 'var(--success)' : 'var(--meta)',
                minHeight: 22, padding: '0 5px', order: 99,
              }}
            >
              {taskIdCopied ? t('common.copied') : `ID: ${task.id}`}
            </Button>
          </>
        }
        onHeaderPointerDown={compact ? undefined : beginPanelMove}
        onHeaderKeyDown={compact ? undefined : moveWithKeyboard}
        onHeaderDoubleClick={compact ? undefined : () => setPanelBounds(initialPanelBounds())}
        locale={locale}
        durationNowMs={durationNowMs}
        currentStep={currentStep}
        activeStep={activeStep}
        currentStepColor={currentStepColor}
        activeStepColor={activeStepColor}
        taskCompleted={taskCompleted}
        runningSteps={runningSteps}
        executionStepModel={executionStepModel}
        sessionIdForStep={sessionIdForStep}
        onViewingPromptChange={setViewingPrompt}
        running={running}
        projectId={projectId}
        previewArtifact={previewArtifact}
        onCloseArtifactPreview={() => setPreviewArtifact(null)}
        onOpenArtifactDirectory={openArtifactDirectory}
        canOpenArtifactDirectory={detailProject?.type !== 'remote'}
        projectType={detailProject?.type}
        viewingPrompt={viewingPrompt}
        onCloseViewingPrompt={() => setViewingPrompt(null)}
        artifactNotice={artifactNotice}
        overlays={<>
          <ConfirmDialog
            open={pendingReviewCompletion !== null}
            title={t('taskDetail.setStepCompleteTitle')}
            message={t('taskDetail.setStepCompleteMessage')}
            confirmText={t('taskDetail.setStepCompleteAndSchedule')}
            secondaryText={t('taskDetail.setStepCompleteOnly')}
            loading={reviewActionPending}
            secondaryDisabled={reviewActionPending}
            onCancel={() => {
              if (!reviewActionPending) setPendingReviewCompletion(null)
            }}
            onConfirm={() => {
              if (pendingReviewCompletion?.kind === 'review') {
                void decideReview(
                  'set-complete', pendingReviewCompletion.review,
                  pendingReviewCompletion.stepKey, true,
                )
              } else if (pendingReviewCompletion?.kind === 'execution') {
                void completeFailedExecution(
                  pendingReviewCompletion.messageId,
                  pendingReviewCompletion.artifactRound, true,
                )
              }
            }}
            onSecondary={() => {
              if (pendingReviewCompletion?.kind === 'review') {
                void decideReview(
                  'set-complete', pendingReviewCompletion.review,
                  pendingReviewCompletion.stepKey, false,
                )
              } else if (pendingReviewCompletion?.kind === 'execution') {
                void completeFailedExecution(
                  pendingReviewCompletion.messageId,
                  pendingReviewCompletion.artifactRound, false,
                )
              }
            }}
          />
          <ConfirmDialog
            open={pendingStepRestart !== null}
            title={t('taskDetail.restartImpactConfirmTitle')}
            message={pendingStepRestart
              ? t('taskDetail.restartImpactConfirmMessage', {
                  target: pendingStepRestart.targetStep.label,
                  active: pendingStepRestart.interruptedSteps
                    .map((step) => step.label)
                    .join('、'),
                  restarted: pendingStepRestart.restartedSteps.length > 0
                    ? pendingStepRestart.restartedSteps
                        .map((step) => step.label)
                        .join('、')
                    : t('taskDetail.restartImpactNoSteps'),
                  cancelled: pendingStepRestart.cancelledSteps.length > 0
                    ? pendingStepRestart.cancelledSteps
                        .map((step) => step.label)
                        .join('、')
                    : t('taskDetail.restartImpactNoSteps'),
                })
              : ''}
            confirmText={t('taskDetail.restartImpactConfirmAction')}
            danger
            loading={stepResuming}
            onCancel={() => {
              if (!stepResuming) setPendingStepRestart(null)
            }}
            onConfirm={() => void confirmUpstreamRestart()}
          />
          {showPromptEditor && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label={t('taskDetail.quickEditPromptAria', { step: currentStep.label })}
              style={{
                position: 'fixed', inset: 0, zIndex: 1275,
                background: 'rgba(0,0,0,0.35)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 24,
              }}
              onClick={() => !promptSaving && setShowPromptEditor(false)}
            >
              <ResizablePanel
                minWidth={520}
                minHeight={320}
                style={{
                  width: 'min(680px, 90vw)', background: 'var(--bg)',
                  borderRadius: 12, boxShadow: '0 18px 48px rgba(0,0,0,0.24)',
                  overflow: 'hidden',
                }}
                onClick={(event) => event.stopPropagation()}
              >
                <div className="dialog-header">
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: currentStepColor }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>{t('taskDetail.quickEditPrompt')}</div>
                    <div style={{ marginTop: 2, fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)' }}>{currentStep.label} · {currentStep.key}</div>
                  </div>
                  <Button variant="icon" disabled={promptSaving} onClick={() => setShowPromptEditor(false)}>✕</Button>
                </div>
                <div style={{ padding: 18 }}>
                  <MarkdownEditor
                    value={promptDraft}
                    onChange={setPromptDraft}
                    projectId={projectId}
                    placeholder={t('taskDetail.promptEditorPlaceholder')}
                    minHeight={260}
                    maxHeight="55vh"
                    autoFocus
                    ariaLabel={t('taskDetail.stepPromptAria', { step: currentStep.label })}
                  />
                  <StepPromptVariablesHint />
                  {promptSaveError && (
                    <div role="alert" style={{ marginTop: 8, color: 'var(--danger)', fontSize: 'calc(13px * var(--font-scale))' }}>
                      {promptSaveError}
                    </div>
                  )}
                </div>
                <div className="dialog-footer">
                  <Button variant="ghost" disabled={promptSaving} onClick={() => setShowPromptEditor(false)}>{t('common.cancel')}</Button>
                  <Button variant="primary" disabled={promptSaving} loading={promptSaving} onClick={saveStepPrompt}>
                    {t('taskDetail.savePrompt')}
                  </Button>
                </div>
              </ResizablePanel>
            </div>
          )}
          <ShareDialog
            open={shareOpen && !!task}
            taskId={taskId}
            projectId={projectId}
            onClose={() => setShareOpen(false)}
          />
        </>}
        onClose={onClose}
        chatScrollRef={chatScrollRef}
        chatEndRef={chatEndRef}
        shouldFollowMessagesRef={shouldFollowMessagesRef}
        lastProgrammaticScrollTopRef={lastProgrammaticScrollTopRef}
        stepLastMessageRefs={stepLastMessageRefs}
        pendingStepScrollRef={pendingStepScrollRef}
        hasUnreadMessages={hasUnreadMessages}
        onUnreadMessagesChange={setHasUnreadMessages}
        />}
      </TaskStepConfigController>
    </div>
  )
}
