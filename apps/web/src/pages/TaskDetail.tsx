import { useSearchParams } from 'react-router-dom'
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
  useLayoutEffect,
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
  type TaskStepState,
} from '../api/client'
import { copyMessageText } from '../components/MessageResponseFooter'
import { a2uiActionMessageParams } from '../utils/a2ui'
import MarkdownEditor from '../components/MarkdownEditor'
import Icon from '../components/Icon'
import ShareDialog from '../components/ShareDialog'
import TaskDetailPage from '../components/TaskDetailPage'
import TaskStageConfigController from '../components/TaskStageConfigController'
import {
  createOptimisticCoordinatorMessage,
  createOptimisticUserMessage,
  resolveTaskDetailAdvanceState,
  resolveTaskChatTarget,
  isVisibleLiveExecutionMessage,
  isUnpersistedLiveMessage,
  isTaskCompleted,
  isTaskNotStarted,
  isStageResumableWithMessage,
  resolveStageDisplayStatus,
  shouldAutoDrainStageInsert,
  mergeLoadedTaskMessageEvents,
  mergeRefreshedTaskHistory,
  findPreferredArtifact,
} from './taskDetailChat'
import { CUSTOM } from '../utils/agui'
import {
  loadTaskInsertQueue,
  saveTaskInsertQueue,
} from '../utils/chatInsertQueue'
import { useI18n, type TKey } from '../i18n'
import { formatScheduledStart, localDateTimeAfter, localDateTimeToIso, utcToLocalDateTime } from '../utils/scheduledStart'

const EMPTY_EVENTS: any[] = []
const EMPTY_LIVE_MESSAGES: Record<string, LiveMessage> = {}

type StageVisualState =
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

interface StageData {
  key: string
  label: string
  color: string
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

interface StageProgress extends Partial<TaskStepState> {
  visualState: StageVisualState
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
  const runTask = useTaskStore((s) => s.runTask)
  const updateTaskDescription = useTaskStore((s) => s.updateTaskDescription)
  const fetchTasks = useTaskStore((s) => s.fetchTasks)
  const refreshTask = useTaskStore((s) => s.refreshTask)
  const updateScheduledStart = useTaskStore((s) => s.updateScheduledStart)
  const [scheduledDraft, setScheduledDraft] = useState('')

  const projectId = detailProject?.id || ''
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
  const [restartingStageKeys, setRestartingStageKeys] = useState<string[]>([])
  const [coordinatorStopping, setCoordinatorStopping] = useState(false)
  const [stageResuming, setStageResuming] = useState(false)
  const [stageInserts, setStageInserts] = useState<Array<{
    id: string
    content: string
  }>>([])
  const [editingInsertId, setEditingInsertId] = useState<string | null>(null)
  const [editingInsertContent, setEditingInsertContent] = useState('')
  const [activeCoordinatorMessageId, setActiveCoordinatorMessageId] = useState<string | null>(null)
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
  const [selectedStage, setSelectedStage] = useState(0)
  const selectedStageTaskRef = useRef<string | null>(null)
  const [hasUnreadMessages, setHasUnreadMessages] = useState(false)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLTextAreaElement>(null)
  const shouldFollowMessagesRef = useRef(true)
  const lastProgrammaticScrollTopRef = useRef(0)
  const stageLastMessageRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const pendingStageScrollRef = useRef<string | null>(null)
  const [historyMessages, setHistoryMessages] = useState<any[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const historyOffsetRef = useRef(0)
  const historyHasOlderRef = useRef(true)
  const historyOlderLoadingRef = useRef(false)
  const historyPrependScrollHeightRef = useRef<number | null>(null)
  const [artifacts, setArtifacts] = useState<TaskArtifact[]>([])
  const [artifactsLoading, setArtifactsLoading] = useState(false)
  const [reviews, setReviews] = useState<ReviewRun[]>([])
  const [reviewActionPending, setReviewActionPending] = useState(false)
  const [reviewComment, setReviewComment] = useState('')
  const [previewArtifact, setPreviewArtifact] = useState<TaskArtifact | null>(null)
  const [artifactNotice, setArtifactNotice] = useState('')
  const [showPromptEditor, setShowPromptEditor] = useState(false)
  const [editReviewMode, setEditReviewMode] = useState<'skip' | 'auto' | 'manual'>('manual')
  const [editReviewRetries, setEditReviewRetries] = useState(1)
  const [editReviewPrompt, setEditReviewPrompt] = useState('')
  const [showReviewDrawer, setShowReviewDrawer] = useState(false)
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
  const historyFetchedRef = useRef<string>('')
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
    if ((event.target as HTMLElement).closest('button, input, textarea, select, a')) {
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

  // Load historical messages when panel opens (or task changes)
  useEffect(() => {
    if (!taskId || !projectId) {
      historyFetchedRef.current = ''
      return
    }
    const fetchKey = `${taskId}-${projectId}`
    if (historyFetchedRef.current === fetchKey) return
    historyFetchedRef.current = fetchKey
    setHistoryLoading(true)
    historyOffsetRef.current = 0
    historyHasOlderRef.current = true
    historyOlderLoadingRef.current = false
    taskApi.history(taskId, projectId, TASK_HISTORY_PAGE_SIZE, 0)
      .then((res) => {
        const messages = res.messages || []
        historyOffsetRef.current = messages.length
        historyHasOlderRef.current = messages.length === TASK_HISTORY_PAGE_SIZE
        setHistoryMessages((current) => mergeRefreshedTaskHistory(current, messages))
      })
      .catch(() => setHistoryMessages([]))
      .finally(() => setHistoryLoading(false))
  }, [taskId, projectId])

  const loadOlderHistory = useCallback(async () => {
    if (
      !taskId || !projectId
      || historyLoading
      || historyOlderLoadingRef.current
      || !historyHasOlderRef.current
    ) return
    historyOlderLoadingRef.current = true
    shouldFollowMessagesRef.current = false
    const container = chatScrollRef.current
    historyPrependScrollHeightRef.current = container?.scrollHeight ?? null
    const offset = historyOffsetRef.current
    try {
      const response = await taskApi.history(taskId, projectId, TASK_HISTORY_PAGE_SIZE, offset)
      const olderMessages = response.messages || []
      historyOffsetRef.current += olderMessages.length
      historyHasOlderRef.current = olderMessages.length === TASK_HISTORY_PAGE_SIZE
      setHistoryMessages((current) => {
        const currentIds = new Set(current.map((message) => String(message.id)))
        return [
          ...olderMessages.filter((message: any) => !currentIds.has(String(message.id))),
          ...current,
        ]
      })
    } catch {
      historyPrependScrollHeightRef.current = null
    } finally {
      historyOlderLoadingRef.current = false
    }
  }, [historyLoading, projectId, taskId])

  useLayoutEffect(() => {
    const previousHeight = historyPrependScrollHeightRef.current
    const container = chatScrollRef.current
    if (previousHeight === null || !container) return
    const nextTop = container.scrollTop + container.scrollHeight - previousHeight
    container.scrollTop = nextTop
    lastProgrammaticScrollTopRef.current = nextTop
    historyPrependScrollHeightRef.current = null
  }, [historyMessages])

  const loadMessageEvents = useCallback(async (messageId: string) => {
    if (!taskId || !projectId) return
    const message = historyMessages.find((item) => item.id === messageId)
    if (!message?.event_detail?.available || message.event_detail.loaded || message.event_detail.loading) return
    setHistoryMessages((current) => current.map((item) => item.id === messageId
      ? { ...item, event_detail: { ...item.event_detail, loading: true, error: '' } }
      : item))
    try {
      let cursor = 0
      let complete = false
      const loadedEvents: any[] = []
      let nextCursor: number | null = null
      while (!complete) {
        const page = await taskApi.messageEvents(taskId, messageId, projectId, cursor)
        loadedEvents.push(...page.events)
        complete = page.complete || page.next_cursor === null
        nextCursor = page.next_cursor
        if (!complete) {
          // 游标必须推进，否则 while 会无限翻页拉取（内存无界增长直至崩溃）。
          if (nextCursor === null || nextCursor === cursor) {
            throw new Error('Event detail cursor did not advance')
          }
          cursor = nextCursor
        }
      }
      setHistoryMessages((current) => mergeLoadedTaskMessageEvents(
        current,
        messageId,
        loadedEvents,
        { complete, next_cursor: nextCursor },
      ))
    } catch (reason) {
      const error = reason instanceof Error ? reason.message : String(reason)
      setHistoryMessages((current) => current.map((item) => item.id === messageId
        ? { ...item, event_detail: { ...item.event_detail, loading: false, error } }
        : item))
    }
  }, [historyMessages, projectId, taskId])

  // A remote peer can send a user message while this detail is open. The
  // store deliberately does not render user messages as live bubbles (they
  // come from persisted history), so refresh history as soon as one arrives.
  useEffect(() => {
    if (!taskId || !projectId || userMessageEvents === 0) return
    const timer = window.setTimeout(() => {
      taskApi.history(taskId, projectId, TASK_HISTORY_PAGE_SIZE, 0)
        .then((response) => setHistoryMessages((current) => (
          mergeRefreshedTaskHistory(current, response.messages || [])
        )))
        .catch(() => undefined)
    }, 50)
    return () => window.clearTimeout(timer)
  }, [projectId, taskId, userMessageEvents])

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

  useEffect(() => {
    if (!taskId || !projectId || !reviewEventSignal) return
    const timer = window.setTimeout(() => {
      taskApi.history(taskId, projectId, TASK_HISTORY_PAGE_SIZE, 0)
        .then((response) => setHistoryMessages((current) => (
          mergeRefreshedTaskHistory(current, response.messages || [])
        )))
        .catch(() => undefined)
    }, 50)
    return () => window.clearTimeout(timer)
  }, [projectId, reviewEventSignal, taskId])

  const refreshArtifacts = useCallback((): Promise<TaskArtifact[]> => {
    if (!taskId || !projectId) return Promise.resolve([])
    return taskApi.artifacts(taskId, projectId)
      .then((res) => {
        setArtifacts(res.artifacts || [])
        return res.artifacts || []
      })
      .catch(() => {
        setArtifacts([])
        return []
      })
  }, [taskId, projectId])

  useEffect(() => {
    if (!taskId || !projectId) {
      setArtifacts([])
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
    if (historyLoading || !pendingStageScrollRef.current) return
    const stageKey = pendingStageScrollRef.current
    const frame = requestAnimationFrame(() => {
      stageLastMessageRefs.current[stageKey]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
      pendingStageScrollRef.current = null
    })
    return () => cancelAnimationFrame(frame)
  }, [historyLoading, historyMessages])

  useEffect(() => {
    if (taskStatus) setRunning(taskStatus === 'running')
  }, [taskStatus])

  // Get stages from project steps
  const stages = useMemo<StageData[]>(() => {
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

  const stageProgress = useMemo<StageProgress[]>(() => {
    const stepByKey = new Map(
      (task?.steps || []).map((step) => [step.step_key, step]),
    )
    const rawStatuses: TaskStepState['status'][] = stages.map((stage: any) => {
      const step = stepByKey.get(stage.key)
      return resolveStageDisplayStatus(
        step?.status || 'pending',
        step?.previous_status,
      ) as TaskStepState['status']
    })
    let activeIndex = rawStatuses.findIndex((status) =>
      ['running', 'reviewing', 'awaiting_review', 'retrying', 'rework', 'rework_waiting'].includes(status)
    )
    if (activeIndex < 0) {
      activeIndex = rawStatuses.findIndex((status) => status === 'failed')
    }
    if (activeIndex < 0) {
      activeIndex = rawStatuses.findIndex((status) => status === 'pending')
    }

    return stages.map((stage, index) => {
      const step = stepByKey.get(stage.key)
      const status = rawStatuses[index]
      let visualState: StageVisualState = 'pending'
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
      return { ...step, visualState }
    })
  }, [stages, task?.steps])

  const activeStageIndex = useMemo(() => {
    const current = stageProgress.findIndex((progress: StageProgress) =>
      ['current', 'reviewing', 'awaiting_review', 'retrying', 'rework', 'rework_waiting'].includes(
        progress.visualState
      )
    )
    if (current >= 0) return current
    const failed = stageProgress.findIndex((progress: StageProgress) =>
      progress.visualState === 'failed'
    )
    return failed >= 0 ? failed : Math.max(0, stages.length - 1)
  }, [stageProgress, stages.length])

  const currentStage = stages[selectedStage] || stages[0]
  const activeStage = stages[activeStageIndex] || stages[0]
  const executionStageModel = activeStage?.model || task?.model || ''

  useEffect(() => {
    if (!task?.id) return
    if (selectedStageTaskRef.current !== task.id) selectedStageTaskRef.current = task.id
    setSelectedStage(activeStageIndex)
  }, [activeStageIndex, task?.id])

  useEffect(() => {
    const config = (task?.review_overrides || {})[currentStage.key]
    const mode = ['skip', 'auto', 'manual'].includes(config?.mode)
      ? config.mode
      : config?.auto
        ? 'auto'
        : 'manual'
    setEditReviewMode(mode)
    setEditReviewRetries(config?.maxRetries ?? 1)
    setEditReviewPrompt(config?.prompt ?? '')
  }, [currentStage.key, task?.review_overrides])

  const shouldTickDuration = taskStatus === 'running' || stageProgress.some(
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

  const runningStages = useMemo(() => {
    const runningKeys = new Set(
      stageProgress
        .filter((progress) => progress.status === 'running')
        .map((progress) => progress.step_key),
    )
    return stages.filter((stage) => runningKeys.has(stage.key))
  }, [stages, stageProgress])

  const resumableStages = useMemo(() => {
    const resumableKeys = new Set(
      stageProgress
        .filter((progress) => (
          isStageResumableWithMessage(progress.status, progress.has_history)
        ))
        .map((progress) => progress.step_key),
    )
    return stages.filter((stage) => resumableKeys.has(stage.key))
  }, [stages, stageProgress])

  const chatTargetStageKey = chatTarget === 'coordinator' ? null : chatTarget
  const chatTargetStage = chatTargetStageKey !== null
  const targetStage = chatTargetStageKey
    ? (runningStages.find((stage) => stage.key === chatTargetStageKey)
      ?? resumableStages.find((stage) => stage.key === chatTargetStageKey)
      ?? null)
    : null
  const activeStageRunning = targetStage !== null
    && runningStages.some((stage) => stage.key === targetStage.key)
  const activeStepStatus = stageProgress[activeStageIndex]?.status || 'pending'

  // When a stage engine starts, the input switches to the matching stage tab
  // for direct insert-into-execution messages; when no stage is running the
  // tab stays on a stopped/failed stage so a message can re-run it; otherwise
  // it returns to the coordinator Agent. Manual user selection is preserved.
  useEffect(() => {
    setChatTarget((current) => {
      if (runningStages.length === 0) {
        return resolveTaskChatTarget(
          current,
          [],
          resumableStages.map((stage) => stage.key),
        )
      }
      return resolveTaskChatTarget(
        current,
        runningStages.map((stage) => stage.key),
        [],
      )
    })
  }, [runningStages, resumableStages])

  /** 向当前可恢复阶段发送一条消息并重新执行该阶段（stage 模式的新 turn）。 */
  const resumeStageWithPrompt = useCallback(async (
    promptText: string,
    opts?: { onErrorRestore?: () => void },
  ): Promise<boolean> => {
    if (!taskId || !projectId || !targetStage) return false
    setChatError('')
    const optimisticId = `pending-${randomUuid()}`
    const optimisticMessage = createOptimisticUserMessage(
      optimisticId,
      promptText,
      targetStage.key,
      new Date().toISOString(),
    )
    shouldFollowMessagesRef.current = true
    setHasUnreadMessages(false)
    setHistoryMessages((current) => [...current, optimisticMessage])
    setStageResuming(true)
    try {
      const accepted = await taskApi.resumeStageWithMessage(
        taskId,
        targetStage.key,
        promptText,
        projectId,
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
      return true
    } catch (reason) {
      setHistoryMessages((current) => current.filter(
        (message) => message.id !== optimisticId
      ))
      opts?.onErrorRestore?.()
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.sendFailed'))
      return false
    } finally {
      setStageResuming(false)
    }
  }, [taskId, projectId, targetStage, t])

  const handleRun = async () => {
    if (!taskId || !projectId) return
    if (!chatTargetStage && coordinatorRunning) return
    // Stage mode (Codex-like): while the stage runs, sends land in the
    // "Insert message" panel above and are injected after the user confirms;
    // after a manual stop, sending persists the message and re-runs the stage.
    if (chatTargetStage) {
      const submittedPrompt = prompt.trim()
      if (!submittedPrompt || stageResuming) return
      if (activeStageRunning) {
        setStageInserts((current) => [
          ...current,
          { id: `insert-${randomUuid()}`, content: submittedPrompt },
        ])
        setPrompt('')
        setChatError('')
        return
      }
      if (!targetStage) return
      setPrompt('')
      await resumeStageWithPrompt(submittedPrompt, {
        onErrorRestore: () => setPrompt(submittedPrompt),
      })
      return
    }
    const submittedPrompt = prompt.trim()
    if (!submittedPrompt) return
    shouldFollowMessagesRef.current = true
    const optimisticId = `pending-${randomUuid()}`
    const optimisticMessage = createOptimisticCoordinatorMessage(
      optimisticId,
      submittedPrompt,
      activeStage.key,
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
    } catch (reason) {
      setHistoryMessages((current) => current.filter(
        (message) => message.id !== optimisticId
      ))
      setPrompt(submittedPrompt)
      setCoordinatorRunning(false)
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.sendFailed'))
    }
  }

  const handleStopCoordinator = async () => {
    if (!taskId || !projectId || coordinatorStopping) return
    setCoordinatorStopping(true)
    setChatError('')
    try {
      const result = await taskApi.stopCoordinator(taskId, projectId)
      if (!result.stopped) {
        // No running turn (may have just ended); events will wrap up naturally.
        setCoordinatorRunning(false)
        setActiveCoordinatorMessageId(null)
        taskApi.history(taskId, projectId)
          .then((res) => setHistoryMessages((current) => (
            mergeRefreshedTaskHistory(current, res.messages || [])
          )))
          .catch(() => undefined)
      }
    } catch (reason) {
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.stopFailed'))
    } finally {
      setCoordinatorStopping(false)
    }
  }

  const handleStopStage = async (stepKey: string) => {
    if (!taskId || !projectId) return
    if (stoppingStepKeys.includes(stepKey)) return
    setChatError('')
    setStoppingStepKeys((current) => [...current, stepKey])
    try {
      await taskApi.cancelStep(taskId, stepKey, projectId)
      // 用户手动停止：该次执行结束不自动推进队列，尊重停止意图
      userStoppedRef.current = true
    } catch (reason) {
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.stopFailed'))
    } finally {
      setStoppingStepKeys((current) => current.filter((key) => key !== stepKey))
    }
  }

  /** 引擎会话丢失（rollout / session 文件被清理）：清空会话，用同一阶段提示词重跑。 */
  const handleRestartStageWithFreshSession = async (stepKey: string) => {
    if (!taskId || !projectId) return
    if (restartingStageKeys.includes(stepKey)) return
    setChatError('')
    setRestartingStageKeys((current) => [...current, stepKey])
    try {
      await taskApi.restartStageWithFreshSession(taskId, stepKey, projectId)
      shouldFollowMessagesRef.current = true
      await refreshTask(taskId, projectId)
    } catch (reason) {
      setChatError(
        reason instanceof Error ? reason.message : t('taskDetail.lostSessionRestartFailed'),
      )
    } finally {
      setRestartingStageKeys((current) => current.filter((key) => key !== stepKey))
    }
  }

  const sendStageInserts = async (items: Array<{ id: string; content: string }>) => {
    if (!taskId || !projectId || !targetStage) return
    if (!items.length) return
    const submitted = items.map((item) => item.content).join('\n\n')
    setChatError('')
    const optimisticId = `pending-${randomUuid()}`
    const optimisticMessage = createOptimisticUserMessage(
      optimisticId,
      submitted,
      targetStage.key,
      new Date().toISOString(),
    )
    setHistoryMessages((current) => [...current, optimisticMessage])
    setStageInserts((current) => current.filter(
      (item) => !items.some((target) => target.id === item.id)
    ))
    try {
      const accepted = await taskApi.sendStageMessage(
        taskId,
        targetStage.key,
        submitted,
        projectId,
        false,
      )
      setHistoryMessages((current) => current.map((message) => (
        message.id === optimisticId
          ? {
              ...message,
              id: accepted.message_id,
              run_id: accepted.message_id,
              channel: 'execution',
              run_status: 'completed',
              sequence: accepted.sequence,
              created_at: accepted.created_at || message.created_at,
            }
            : message
      )))
    } catch (reason) {
      setHistoryMessages((current) => current.filter(
        (message) => message.id !== optimisticId
      ))
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.sendFailed'))
    }
  }

  const handleStageInsertRemove = (insertId: string) => {
    setStageInserts((current) => current.filter((item) => item.id !== insertId))
  }

  const handleStageInsertEditStart = (insert: { id: string; content: string }) => {
    setEditingInsertId(insert.id)
    setEditingInsertContent(insert.content)
  }

  const handleStageInsertEditSave = (insertId: string) => {
    const nextContent = editingInsertContent.trim()
    if (!nextContent) return
    setStageInserts((current) => current.map((item) => (
      item.id === insertId ? { ...item, content: nextContent } : item
    )))
    setEditingInsertId(null)
    setEditingInsertContent('')
  }

  const handleStageInsertEditCancel = () => {
    setEditingInsertId(null)
    setEditingInsertContent('')
  }

  const handleStageInsertSend = (insert: { id: string; content: string }) => {
    void sendStageInserts([insert])
  }

  const handleSendAllInserts = () => {
    void sendStageInserts(stageInserts)
  }

  // ── 插入队列持久化 ─────────────────────────────
  // 任务详情无会话概念，队列是任务级的，以 taskId 为作用域保存，刷新后恢复。
  // stageQueueOwnerRef 记录当前队列表项归属的 task。切换任务时先把旧 owner
  // 的内容落盘，再恢复新 task；保存 effect 不跟随“新 task + 旧 items”的中间态。
  const stageQueueOwnerRef = useRef<{
    projectId: string
    taskId: string
    items: Array<{ id: string; content: string }>
  } | null>(null)
  const stageQueueKey = taskId && projectId ? projectId + ':' + taskId : ''
  const [stageQueueReadyKey, setStageQueueReadyKey] = useState('')
  const stageQueueReady = Boolean(stageQueueKey && stageQueueReadyKey === stageQueueKey)

  const removeStageQueueItems = useCallback((
    owner: NonNullable<typeof stageQueueOwnerRef.current>,
    ids: string[],
  ) => {
    owner.items = owner.items.filter((item) => !ids.includes(item.id))
    saveTaskInsertQueue(owner.taskId, owner.items)
    const current = stageQueueOwnerRef.current
    if (
      current?.projectId === owner.projectId
      && current.taskId === owner.taskId
    ) {
      setStageInserts(owner.items)
    }
  }, [])

  useEffect(() => {
    if (!taskId || !projectId) return
    const owner = stageQueueOwnerRef.current
    if (owner && owner.taskId !== taskId) {
      saveTaskInsertQueue(owner.taskId, owner.items)
    }
    const items = loadTaskInsertQueue(taskId, projectId)
    stageQueueOwnerRef.current = { projectId, taskId, items }
    setStageInserts(owner?.taskId === taskId ? owner.items : items)
    setStageQueueReadyKey(stageQueueKey)
  }, [taskId, projectId, stageQueueKey])

  useEffect(() => {
    const owner = stageQueueOwnerRef.current
    if (!owner || !stageQueueReady) return
    owner.items = stageInserts
    saveTaskInsertQueue(owner.taskId, stageInserts)
  }, [stageInserts, stageQueueReady])

  // ─ 插入队列自动推进 ─────────────────────────────
  // 阶段运行中插入的消息先排队；队列非空且该阶段已不再运行、可重新发送时，
  // 自动发送队首消息并重新执行该阶段，直至队列清空。
  // 成功完成或页面重挂后没有 running 跃迁，也要继续推进；手动停止仍尊重停止意图。
  const prevStageRunRef = useRef<{ key: string | null; running: boolean }>({
    key: null,
    running: false,
  })
  const stageAutoDrainingRef = useRef(false)
  const awaitingStageRunStartKeysRef = useRef<Set<string>>(new Set())
  const userStoppedRef = useRef(false)
  const stageRunKey = taskId && targetStage ? `${taskId}:${targetStage.key}` : ''

  useEffect(() => {
    if (activeStageRunning && stageRunKey) {
      awaitingStageRunStartKeysRef.current.delete(stageRunKey)
    }
  }, [activeStageRunning, stageRunKey])

  useEffect(() => {
    const prev = prevStageRunRef.current
    const shouldDrain = shouldAutoDrainStageInsert({
      previousKey: prev.key,
      stageRunKey,
      queueReady: stageQueueReady,
      activeStageRunning,
      autoDraining: stageAutoDrainingRef.current,
      awaitingRunStart: awaitingStageRunStartKeysRef.current.has(stageRunKey),
      editingInsert: editingInsertId !== null,
      queueLength: stageInserts.length,
    })
    prevStageRunRef.current = { key: stageRunKey || null, running: activeStageRunning }
    if (!shouldDrain) return
    if (userStoppedRef.current) {
      // 用户手动停止的这次结束不自动推进
      userStoppedRef.current = false
      return
    }
    if (!taskId || !projectId || !targetStage) return
    const owner = stageQueueOwnerRef.current
    if (!owner || owner.taskId !== taskId || owner.projectId !== projectId) return
    const first = stageInserts[0]
    const submittedStageRunKey = stageRunKey
    stageAutoDrainingRef.current = true
    void resumeStageWithPrompt(first.content).then((ok) => {
      if (ok) {
        awaitingStageRunStartKeysRef.current.add(submittedStageRunKey)
        removeStageQueueItems(owner, [first.id])
        setEditingInsertId(null)
        setEditingInsertContent('')
      }
      stageAutoDrainingRef.current = false
    })
  }, [activeStageRunning, targetStage, stageInserts, editingInsertId, taskId, projectId, stageRunKey, stageQueueReady, resumeStageWithPrompt, removeStageQueueItems])

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
      activeStage.key,
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
  }, [taskId, projectId, activeStage, t])

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

  const handleStart = async () => {
    if (!taskId || !projectId || !taskNotStarted || running) return
    setRunning(true)
    try {
      await runTask(taskId, '', projectId)
    } catch {
      setRunning(false)
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

  const currentStageColor = currentStage.color || 'var(--accent)'
  const activeStageColor = activeStage.color || 'var(--accent)'
  const selectedReview = reviews.find((review) => review.step_key === currentStage.key)
  const activeReview = reviews.find((review) => review.step_key === activeStage.key)

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
    setPromptDraft(currentStage.prompt)
    setPromptSaveError('')
    setShowPromptEditor(true)
  }

  const saveStagePrompt = async () => {
    if (!detailProject) return
    const currentSteps = detailProject.steps
    let nextSteps = currentSteps
    if (currentSteps?.nodes?.length) {
      nextSteps = {
        ...currentSteps,
        nodes: currentSteps.nodes.map((node: any) =>
          (node.type || node.key) === currentStage.key
            ? { ...node, prompt: promptDraft }
            : node
        ),
      }
    } else if (currentSteps?.steps?.length) {
      nextSteps = {
        ...currentSteps,
        steps: currentSteps.steps.map((step: any) =>
          (step.key || step.id) === currentStage.key
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

  const handleStageClick = (stageIndex: number) => {
    setSelectedStage(stageIndex)
    const stageKey = stages[stageIndex]?.key
    if (!stageKey) return

    pendingStageScrollRef.current = stageKey
    if (historyLoading) return

    requestAnimationFrame(() => {
      stageLastMessageRefs.current[stageKey]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
      pendingStageScrollRef.current = null
    })
  }

  const decideReview = async (
    decision: 'approve' | 'reject' | 'force-approve',
    review = selectedReview,
    stepKey = currentStage.key,
  ) => {
    if (!review || !projectId) return
    setReviewActionPending(true)
    try {
      await taskApi.decideReview(
        task.id,
        stepKey,
        review.id,
        decision,
        projectId,
        reviewComment.trim() || undefined,
      )
      setReviewComment('')
      const [reviewResult] = await Promise.all([
        taskApi.reviews(task.id, projectId),
        fetchTasks(projectId),
      ])
      setReviews(reviewResult.reviews || [])
    } finally {
      setReviewActionPending(false)
    }
  }

  const globalAdvance = () => {
    if (taskNotStarted) {
      void handleStart()
      return
    }
    if (!activeReview) return
    if (activeStepStatus === 'awaiting_review') {
      void decideReview('approve', activeReview, activeStage.key)
    } else if (activeStepStatus === 'rejected') {
      void decideReview('force-approve', activeReview, activeStage.key)
    }
  }

  const globalAdvanceState = resolveTaskDetailAdvanceState({
    taskNotStarted,
    running,
    taskStatus: task.status,
    stepStates: task.steps,
    activeStepStatus,
    reviewActionPending,
    hasActiveReview: Boolean(activeReview),
    t,
  })

  const findArtifact = (name: string, preferredStepKey?: string, source?: TaskArtifact[]) => {
    return findPreferredArtifact(source || artifacts, name, preferredStepKey)
  }

  const openArtifact = (name: string, preferredStepKey?: string) => {
    if (artifactsLoading && artifacts.length === 0) {
      setArtifactNotice(t('taskDetail.artifactLoading'))
    } else {
      const artifact = findArtifact(name, preferredStepKey)
      if (artifact) {
        setPreviewArtifact(artifact)
        setArtifactNotice('')
        return
      }
      // 阶段可能刚执行完、产物列表尚未刷新：重新拉取一次再尝试打开。
      setArtifactNotice(t('taskDetail.artifactLoading'))
      refreshArtifacts().then((fresh) => {
        const latest = findArtifact(name, preferredStepKey, fresh)
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

      <TaskStageConfigController
        projectId={projectId || ''}
        taskId={task.id}
        stepKey={chatTargetStageKey}
        running={activeStageRunning}
      >
        {({ inputConfig: stageEngineConfig, loading: stageEngineConfigLoading, error: stageEngineConfigError }) => <TaskDetailPage
        task={task}
        stages={stages}
        stageProgress={stageProgress}
        selectedStage={selectedStage}
        onStageClick={handleStageClick}
        historyMessages={historyMessages}
        onLoadOlderHistory={loadOlderHistory}
        onLoadMessageEvents={(messageId) => void loadMessageEvents(messageId)}
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
        onOpenArtifact={openArtifact}
        chatTarget={chatTarget}
        onChatTargetChange={setChatTarget}
        coordinatorRunning={coordinatorRunning}
        coordinatorConfig={coordinatorConfig}
        stageEngineConfig={stageEngineConfig}
        stageEngineConfigLoading={stageEngineConfigLoading}
        stageEngineConfigError={stageEngineConfigError}
        chatError={chatError}
        onChatError={setChatError}
        prompt={prompt}
        onPromptChange={setPrompt}
        onSend={handleRun}
        onStop={chatTarget !== 'coordinator' && activeStageRunning
          ? () => void handleStopStage(chatTarget)
          : handleStopCoordinator}
        stoppingStepKeys={stoppingStepKeys}
        stageResuming={stageResuming}
        onStopStage={handleStopStage}
        onRestartStageWithFreshSession={handleRestartStageWithFreshSession}
        restartingStageKeys={restartingStageKeys}
        chatInputRef={chatInputRef}
        stageInserts={stageInserts}
        onStageInsertRemove={handleStageInsertRemove}
        onStageInsertSend={handleStageInsertSend}
        onStageInsertEditStart={handleStageInsertEditStart}
        onStageInsertEditSave={handleStageInsertEditSave}
        onStageInsertEditCancel={handleStageInsertEditCancel}
        editingInsertId={editingInsertId}
        editingInsertContent={editingInsertContent}
        onEditingInsertContentChange={setEditingInsertContent}
        onSendAllInserts={handleSendAllInserts}
        onClearInserts={() => setStageInserts([])}
        onStageInsertReorder={(fromIndex, toIndex) => setStageInserts((current) => {
          if (
            fromIndex === toIndex
            || fromIndex < 0 || fromIndex >= current.length
            || toIndex < 0 || toIndex >= current.length
          ) return current
          const next = [...current]
          const [moved] = next.splice(fromIndex, 1)
          next.splice(toIndex, 0, moved)
          return next
        })}
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
        showReviewDrawer={showReviewDrawer}
        onShowReviewDrawerChange={setShowReviewDrawer}
        editReviewMode={editReviewMode}
        onEditReviewModeChange={(value) => setEditReviewMode(value as 'skip' | 'auto' | 'manual')}
        editReviewRetries={editReviewRetries}
        onEditReviewRetriesChange={setEditReviewRetries}
        editReviewPrompt={editReviewPrompt}
        onEditReviewPromptChange={setEditReviewPrompt}
        onSaveReviewConfig={async () => {
          const updated = {
            ...(task.review_overrides || {}),
            [currentStage.key]: {
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
        onProposalOverride={(updated) => setProposalOverrides((current) => ({ ...current, [updated.id]: updated }))}
        headerActions={
          <>
            <Button
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
        currentStage={currentStage}
        activeStage={activeStage}
        currentStageColor={currentStageColor}
        activeStageColor={activeStageColor}
        taskCompleted={taskCompleted}
        runningStages={runningStages}
        executionStageModel={executionStageModel}
        sessionIdForStep={sessionIdForStep}
        onViewingPromptChange={setViewingPrompt}
        running={running}
        projectId={projectId}
        primaryAction={{
          label: globalAdvanceState.label,
          disabled: globalAdvanceState.disabled,
          loading: reviewActionPending,
          onClick: globalAdvance,
        }}
        previewArtifact={previewArtifact}
        onCloseArtifactPreview={() => setPreviewArtifact(null)}
        onOpenArtifactDirectory={openArtifactDirectory}
        canOpenArtifactDirectory={detailProject?.type !== 'remote'}
        viewingPrompt={viewingPrompt}
        onCloseViewingPrompt={() => setViewingPrompt(null)}
        artifactNotice={artifactNotice}
        overlays={<>
          {showPromptEditor && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label={t('taskDetail.quickEditPromptAria', { stage: currentStage.label })}
              style={{
                position: 'fixed', inset: 0, zIndex: 1275,
                background: 'rgba(0,0,0,0.35)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 24,
              }}
              onClick={() => !promptSaving && setShowPromptEditor(false)}
            >
              <div
                style={{
                  width: 'min(680px, 90vw)', background: 'var(--bg)',
                  borderRadius: 12, boxShadow: '0 18px 48px rgba(0,0,0,0.24)',
                  overflow: 'hidden',
                }}
                onClick={(event) => event.stopPropagation()}
              >
                <div className="dialog-header">
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: currentStageColor }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>{t('taskDetail.quickEditPrompt')}</div>
                    <div style={{ marginTop: 2, fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)' }}>{currentStage.label} · {currentStage.key}</div>
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
                    ariaLabel={t('taskDetail.stagePromptAria', { stage: currentStage.label })}
                  />
                  {promptSaveError && (
                    <div role="alert" style={{ marginTop: 8, color: 'var(--danger)', fontSize: 'calc(13px * var(--font-scale))' }}>
                      {promptSaveError}
                    </div>
                  )}
                </div>
                <div className="dialog-footer">
                  <Button variant="ghost" disabled={promptSaving} onClick={() => setShowPromptEditor(false)}>{t('common.cancel')}</Button>
                  <Button variant="primary" disabled={promptSaving} loading={promptSaving} onClick={saveStagePrompt}>
                    {t('taskDetail.savePrompt')}
                  </Button>
                </div>
              </div>
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
        stageLastMessageRefs={stageLastMessageRefs}
        pendingStageScrollRef={pendingStageScrollRef}
        hasUnreadMessages={hasUnreadMessages}
        onUnreadMessagesChange={setHasUnreadMessages}
        />}
      </TaskStageConfigController>
    </div>
  )
}
