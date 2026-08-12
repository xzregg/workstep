import Button from '../components/Button'
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
import {
  fsApi,
  projectApi,
  taskApi,
  type ActionProposal,
  type CoordinatorConfig,
  type ReviewRun,
  type TaskArtifact,
  type TaskStepState,
} from '../api/client'
import ArtifactPreview from '../components/ArtifactPreview'
import { copyMessageText } from '../components/MessageResponseFooter'
import { a2uiActionMessageParams } from '../utils/a2ui'
import MarkdownEditor from '../components/MarkdownEditor'
import MarkdownMessage from '../components/MarkdownMessage'
import Icon from '../components/Icon'
import ShareDialog from '../components/ShareDialog'
import TaskDetailView from '../components/TaskDetailView'
import {
  createOptimisticUserMessage,
  isVisibleLiveExecutionMessage,
  isUnpersistedLiveMessage,
  isTaskCompleted,
  isTaskNotStarted,
  conversationBottomScrollTop,
} from './taskDetailChat'
import {
  type DateTimeValue,
} from '../utils/datetime'
import { useI18n, type TKey } from '../i18n'

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
    return clampPanelBounds(parsed as PanelBounds)
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
  const setActiveProject = useProjectStore((s) => s.setActiveProject)
  const tasks = useTaskStore((s) => s.tasks)
  const events = useTaskStore((s) => (taskId ? s.events[taskId] : undefined) ?? EMPTY_EVENTS)
  const content = useTaskStore((s) => (taskId ? s.content[taskId] : '') ?? '')
  const liveMessages = useTaskStore((s) => (
    taskId ? s.liveMessages[taskId] : undefined
  ) ?? EMPTY_LIVE_MESSAGES)
  const runTask = useTaskStore((s) => s.runTask)
  const updateTaskDescription = useTaskStore((s) => s.updateTaskDescription)
  const fetchTasks = useTaskStore((s) => s.fetchTasks)

  const projectId = activeProject?.id || ''
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
    const event = [...events].reverse().find((item) =>
      ['review_status', 'review_result', 'step_retrying'].includes(item.type)
    )
    return event
      ? `${event.type}:${event.data?.review_run_id || ''}:${event.data?.status || event.data?.attempt || ''}`
      : ''
  }, [events])
  const [prompt, setPrompt] = useState('')
  const [running, setRunning] = useState(false)
  const [coordinatorRunning, setCoordinatorRunning] = useState(false)
  const [chatTarget, setChatTarget] = useState<string | 'coordinator'>('coordinator')
  const [chatError, setChatError] = useState('')
  const [stoppingStepKeys, setStoppingStepKeys] = useState<string[]>([])
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
  const [panelBounds, setPanelBounds] = useState(initialPanelBounds)
  const [splitRatio, setSplitRatio] = useState(initialSplitRatio)
  const historyFetchedRef = useRef<string>('')
  const interactionCleanupRef = useRef<(() => void) | null>(null)
  const persistedMessageIds = useMemo(
    () => new Set(historyMessages.map((message) => String(message.id))),
    [historyMessages],
  )
  const liveCoordinatorMessages = useMemo(
    () => Object.values(liveMessages).filter(
      (message) => message.channel === 'coordinator'
        && isUnpersistedLiveMessage(message, persistedMessageIds),
    ),
    [liveMessages, persistedMessageIds],
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
    sessionStorage.setItem(PANEL_BOUNDS_KEY, JSON.stringify(panelBounds))
  }, [panelBounds])

  useEffect(() => {
    sessionStorage.setItem(SPLIT_RATIO_KEY, String(splitRatio))
  }, [splitRatio])

  useEffect(() => {
    setSplitRatio((current) => clampSplitRatio(current, panelBounds.width))
  }, [panelBounds.width])

  useEffect(() => {
    const handleViewportResize = () => {
      setPanelBounds((current) => clampPanelBounds(current))
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
    document.body.style.userSelect = 'none'

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
    taskApi.history(taskId, projectId, 50, 0)
      .then((res) => setHistoryMessages(res.messages || []))
      .catch(() => setHistoryMessages([]))
      .finally(() => setHistoryLoading(false))
  }, [taskId, projectId])

  useEffect(() => {
    if (!taskId || !projectId || missingLivePromptIds.length === 0) return
    let cancelled = false
    const missingIds = new Set(missingLivePromptIds)
    taskApi.history(taskId, projectId, 50, 0)
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
        setCoordinatorConfigError('')
      })
      .catch((reason) => setCoordinatorConfigError(
        reason instanceof Error ? reason.message : t('taskDetail.coordinatorEngineLoadFailed'),
      ))
  }, [taskId, projectId, t])

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
      taskApi.history(taskId, projectId, 50, 0)
        .then((response) => setHistoryMessages(response.messages || []))
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
    if (historyLoading) return
    if (shouldFollowMessagesRef.current) {
      const container = chatScrollRef.current
      if (container) {
        const target = conversationBottomScrollTop(
          container.scrollHeight,
          container.clientHeight,
        )
        lastProgrammaticScrollTopRef.current = target
        container.scrollTop = target
      }
      setHasUnreadMessages(false)
    } else {
      setHasUnreadMessages(true)
    }
  }, [events, content, historyMessages, historyLoading, liveCoordinatorMessages, liveExecutionMessages])

  useEffect(() => {
    shouldFollowMessagesRef.current = true
    setHasUnreadMessages(false)
  }, [taskId])

  // 图片/媒体异步加载会撑高内容且不触发上面的跟随 effect，
  // 跟随中时在 capture 阶段监听 load 重新钉底。
  useEffect(() => {
    const container = chatScrollRef.current
    if (!container) return
    const onMediaLoad = () => {
      if (!shouldFollowMessagesRef.current) return
      const target = conversationBottomScrollTop(
        container.scrollHeight,
        container.clientHeight,
      )
      lastProgrammaticScrollTopRef.current = target
      container.scrollTop = target
    }
    container.addEventListener('load', onMediaLoad, true)
    return () => container.removeEventListener('load', onMediaLoad, true)
  }, [])

  useEffect(() => {
    if (!activeCoordinatorMessageId) return
    const activeMessage = liveMessages[activeCoordinatorMessageId]
    if (!activeMessage || !['succeeded', 'failed', 'stopped'].includes(activeMessage.status)) return
    setCoordinatorRunning(false)
    setActiveCoordinatorMessageId(null)
    if (taskId && projectId) {
      taskApi.history(taskId, projectId)
        .then((res) => setHistoryMessages(res.messages || []))
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
    const steps = activeProject?.steps
    if (steps?.nodes?.length) return steps.nodes.map((n: any) => ({ key: n.type || n.key, label: n.title || n.label, color: n.color || 'var(--meta)', engine: n.engine || '', model: n.model || '', prompt: n.prompt || '', config: n.config || {}, inputs: (n.inputs || []).map((i: any) => ({ name: i.name, type: i.type, outputs: i.outputs || [] })), outputs: (n.outputs || []).map((o: any) => ({ name: o.name, type: o.type })) }))
    if (steps?.steps?.length) return steps.steps.map((s: any) => ({ key: s.key || s.id, label: s.label || s.name, color: s.color || 'var(--meta)', engine: s.engine || '', model: s.model || '', prompt: s.prompt || '', config: s.config || {}, inputs: (s.inputs || []).map((i: any) => ({ name: i.name || i, type: i.type || 'any', outputs: i.outputs || [] })), outputs: (s.outputs || []).map((o: any) => ({ name: o.name || o, type: o.type || 'any' })) }))
    return [{ key: 'do', label: t('taskList.execute'), color: 'var(--accent)', engine: '', model: '', prompt: '', inputs: [], outputs: [] }]
  }, [activeProject?.steps, t])

  const stageProgress = useMemo<StageProgress[]>(() => {
    const stepByKey = new Map(
      (task?.steps || []).map((step) => [step.step_key, step]),
    )
    const rawStatuses: TaskStepState['status'][] = stages.map(
      (stage: any) => stepByKey.get(stage.key)?.status || 'pending',
    )
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
  const executionOrigin = useMemo<DateTimeValue>(() => {
    const step = (task?.steps || []).find(
      (item: any) => item.step_key === activeStage?.key,
    )
    return step?.started_at || task?.created_at || null
  }, [task, activeStage])

  useEffect(() => {
    if (!task?.id || selectedStageTaskRef.current === task.id) return
    setSelectedStage(activeStageIndex)
    selectedStageTaskRef.current = task.id
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

  const stoppedStages = useMemo(() => {
    const stoppedKeys = new Set(
      stageProgress
        .filter((progress) => progress.status === 'cancelled')
        .map((progress) => progress.step_key),
    )
    return stages.filter((stage) => stoppedKeys.has(stage.key))
  }, [stages, stageProgress])

  const chatTargetStageKey = chatTarget === 'coordinator' ? null : chatTarget
  const chatTargetStage = chatTargetStageKey !== null
  const targetStage = chatTargetStageKey
    ? (runningStages.find((stage) => stage.key === chatTargetStageKey)
      ?? stoppedStages.find((stage) => stage.key === chatTargetStageKey)
      ?? null)
    : null
  const activeStageRunning = targetStage !== null
    && runningStages.some((stage) => stage.key === targetStage.key)
  const activeStepStatus = stageProgress[activeStageIndex]?.status || 'pending'

  // When a stage engine starts, the input switches to the matching stage tab
  // for direct insert-into-execution messages; after a manual stop the tab
  // stays on the stopped stage so a message can re-run it; otherwise it
  // returns to the coordinator Agent. Manual user selection is preserved.
  useEffect(() => {
    setChatTarget((current) => {
      if (runningStages.length === 0) {
        if (current !== 'coordinator' && stoppedStages.some((stage) => stage.key === current)) {
          return current
        }
        return stoppedStages[0]?.key ?? 'coordinator'
      }
      if (current !== 'coordinator' && runningStages.some((stage) => stage.key === current)) {
        return current
      }
      return runningStages[0].key
    })
  }, [runningStages, stoppedStages])

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
          { id: `insert-${crypto.randomUUID()}`, content: submittedPrompt },
        ])
        setPrompt('')
        setChatError('')
        return
      }
      if (!targetStage) return
      setChatError('')
      const optimisticId = `pending-${crypto.randomUUID()}`
      const optimisticMessage = createOptimisticUserMessage(
        optimisticId,
        submittedPrompt,
        targetStage.key,
        new Date().toISOString(),
      )
      shouldFollowMessagesRef.current = true
      setHasUnreadMessages(false)
      setHistoryMessages((current) => [...current, optimisticMessage])
      setPrompt('')
      setStageResuming(true)
      try {
        const accepted = await taskApi.resumeStageWithMessage(
          taskId,
          targetStage.key,
          submittedPrompt,
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
      } catch (reason) {
        setHistoryMessages((current) => current.filter(
          (message) => message.id !== optimisticId
        ))
        setPrompt(submittedPrompt)
        setChatError(reason instanceof Error ? reason.message : t('taskDetail.sendFailed'))
      } finally {
        setStageResuming(false)
      }
      return
    }
    const submittedPrompt = prompt.trim()
    if (!submittedPrompt) return
    shouldFollowMessagesRef.current = true
    const optimisticId = `pending-${crypto.randomUUID()}`
    const optimisticMessage = createOptimisticUserMessage(
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
        crypto.randomUUID(),
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
          .then((res) => setHistoryMessages(res.messages || []))
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
    } catch (reason) {
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.stopFailed'))
    } finally {
      setStoppingStepKeys((current) => current.filter((key) => key !== stepKey))
    }
  }

  const sendStageInserts = async (items: Array<{ id: string; content: string }>) => {
    if (!taskId || !projectId || !targetStage) return
    if (!items.length) return
    const submitted = items.map((item) => item.content).join('\n\n')
    setChatError('')
    const optimisticId = `pending-${crypto.randomUUID()}`
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

  // A2UI protocol: clicks inside rendered UI bubbles (buttons, pickers, ...)
  // arrive as client actions. Relay them to the coordinator as a user message
  // so the model sees what the user selected and can continue the turn.
  const handleA2uiAction = useCallback((action: A2uiClientAction) => {
    if (!taskId || !projectId) return
    const content = t(
      'taskDetail.a2uiActionMessage',
      a2uiActionMessageParams(action),
    )
    const optimisticId = `pending-a2ui-${crypto.randomUUID()}`
    const optimisticMessage = createOptimisticUserMessage(
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
    taskApi.chat(taskId, content, projectId, crypto.randomUUID())
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
    await taskApi.respondInteraction(interactionId, response)
  }, [])

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
    setDescriptionError('')
    setEditingDescription(true)
  }

  const saveDescription = async () => {
    if (!projectId) return
    setDescriptionSaving(true)
    setDescriptionError('')
    try {
      await updateTaskDescription(task.id, descriptionDraft, projectId)
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
    if (!activeProject) return
    const currentSteps = activeProject.steps
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
      await projectApi.saveSteps(activeProject.id, nextSteps)
      setActiveProject({ ...activeProject, steps: nextSteps })
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

  const globalAdvanceState = (() => {
    if (taskNotStarted) {
      return {
        label: running ? t('taskDetail.starting') : t('taskList.start'),
        disabled: running,
      }
    }
    if (
      task.status === 'ready'
      && task.steps.every(
        (step) => step.status === 'passed' || step.status === 'skipped'
      )
    ) {
      return { label: t('taskDetail.workflowCompleted'), disabled: true }
    }
    if (activeStepStatus === 'awaiting_review') {
      return {
        label: t('taskDetail.approveAndAdvance'),
        disabled: reviewActionPending || !activeReview,
      }
    }
    if (activeStepStatus === 'rejected') {
      return {
        label: t('taskDetail.forceApproveAndAdvance'),
        disabled: reviewActionPending || !activeReview,
      }
    }
    if (activeStepStatus === 'reviewing') {
      return { label: t('taskDetail.reviewing'), disabled: true }
    }
    if (activeStepStatus === 'retrying') {
      return { label: t('taskDetail.autoRerunning'), disabled: true }
    }
    if (activeStepStatus === 'running') {
      return { label: t('taskDetail.stageRunning'), disabled: true }
    }
    return { label: t('taskDetail.waitForStage'), disabled: true }
  })()

  const findArtifact = (name: string, preferredStepKey?: string, source?: TaskArtifact[]) => {
    const normalize = (value: string) =>
      value.toLocaleLowerCase().replace(/[\s_.-]/g, '')
    const normalizedName = normalize(name)
    const list = source || artifacts
    const candidates = preferredStepKey
      ? list.filter((artifact) => artifact.step_key === preferredStepKey)
      : list
    return candidates.find((artifact) => artifact.logical_name === name)
      || candidates.find((artifact) => {
        const artifactName = normalize(artifact.logical_name || artifact.name)
        return artifactName.includes(normalizedName)
          || normalizedName.includes(artifactName)
      })
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
    if (!previewArtifact) return
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
      {RESIZE_EDGES.map((edge) => (
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

      <TaskDetailView
        task={task}
        stages={stages}
        stageProgress={stageProgress}
        selectedStage={selectedStage}
        onStageClick={handleStageClick}
        historyMessages={historyMessages}
        liveMessages={liveMessages}
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
        chatError={chatError}
        prompt={prompt}
        onPromptChange={setPrompt}
        onSend={handleRun}
        onStop={chatTarget !== 'coordinator' && activeStageRunning
          ? () => void handleStopStage(chatTarget)
          : handleStopCoordinator}
        stoppingStepKeys={stoppingStepKeys}
        stageResuming={stageResuming}
        onStopStage={handleStopStage}
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
        onCoordinatorEngineChange={handleCoordinatorEngineChange}
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
        onCancelDescriptionEdit={() => setEditingDescription(false)}
        onOpenDescriptionEditor={openDescriptionEditor}
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
                minHeight: 22, padding: '0 7px', fontSize: 11, color: 'var(--meta)',
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
                fontFamily: 'var(--font-mono)', fontSize: 11,
                color: taskIdCopied ? 'var(--success)' : 'var(--meta)',
                minHeight: 22, padding: '0 5px', order: 99,
              }}
            >
              {taskIdCopied ? t('common.copied') : `ID: ${task.id}`}
            </Button>
          </>
        }
        locale={locale}
        durationNowMs={durationNowMs}
        currentStage={currentStage}
        activeStage={activeStage}
        currentStageColor={currentStageColor}
        activeStageColor={activeStageColor}
        taskCompleted={taskCompleted}
        runningStages={runningStages}
        executionStageModel={executionStageModel}
        executionOrigin={executionOrigin}
        sessionIdForStep={sessionIdForStep}
        onViewingPromptChange={setViewingPrompt}
        running={running}
        projectId={projectId}
        onClose={onClose}
        chatScrollRef={chatScrollRef}
        chatEndRef={chatEndRef}
        shouldFollowMessagesRef={shouldFollowMessagesRef}
        lastProgrammaticScrollTopRef={lastProgrammaticScrollTopRef}
        stageLastMessageRefs={stageLastMessageRefs}
        pendingStageScrollRef={pendingStageScrollRef}
        hasUnreadMessages={hasUnreadMessages}
        onScrollToBottom={() => {
          shouldFollowMessagesRef.current = true
          setHasUnreadMessages(false)
          const container = chatScrollRef.current
          if (container) {
            const target = conversationBottomScrollTop(container.scrollHeight, container.clientHeight)
            lastProgrammaticScrollTopRef.current = target
            container.scrollTop = target
          }
        }}
      />
      <div style={{ padding: '14px 24px', borderTop: '1px solid var(--border-soft)', display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0 }}>
        <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
        <Button
          variant="primary"
          disabled={globalAdvanceState.disabled}
          loading={reviewActionPending}
          onClick={globalAdvance}
          style={globalAdvanceState.disabled ? {
            background: 'var(--border)',
            color: 'var(--meta)',
            borderColor: 'var(--border)',
            cursor: 'not-allowed',
            opacity: 1,
          } : undefined}
        >
          {globalAdvanceState.label}
        </Button>
      </div>

      {artifactNotice && (
        <div style={{
          position: 'fixed', top: 18, left: '50%', transform: 'translateX(-50%)',
          zIndex: 1300, padding: '8px 16px', borderRadius: 6,
          background: 'var(--fg)', color: 'var(--bg)', fontSize: 13,
          boxShadow: 'var(--elev-raised)',
        }}>
          {artifactNotice}
        </div>
      )}

      {viewingPrompt && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('aiFlow.fullPrompt')}
          style={{
            position: 'fixed', inset: 0, zIndex: 1350,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 24,
          }}
          onClick={() => setViewingPrompt(null)}
        >
          <div
            style={{
              width: 'min(860px, 92vw)', maxHeight: '84vh',
              background: 'var(--bg)', borderRadius: 12,
              boxShadow: '0 18px 48px rgba(0,0,0,0.24)',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dialog-header">
              <strong style={{ flex: 1, fontSize: 13 }}>{t('aiFlow.fullPrompt')}</strong>
              <Button variant="icon" aria-label={t('aiFlow.closePrompt')} onClick={() => setViewingPrompt(null)}>✕</Button>
            </div>
            <div style={{ padding: 18, overflow: 'auto', fontSize: 13, lineHeight: 1.65 }}>
              <MarkdownMessage content={viewingPrompt} />
            </div>
          </div>
        </div>
      )}

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
                <div style={{ fontSize: 13, fontWeight: 600 }}>{t('taskDetail.quickEditPrompt')}</div>
                <div style={{ marginTop: 2, fontSize: 11, color: 'var(--meta)' }}>{currentStage.label} · {currentStage.key}</div>
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
                <div role="alert" style={{ marginTop: 8, color: 'var(--danger)', fontSize: 13 }}>
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

      {previewArtifact && (
        <div
          role="dialog"
          aria-label={t('taskDetail.artifactPreviewAria', { name: previewArtifact.logical_name || previewArtifact.name })}
          style={{
            position: 'fixed', inset: 0, zIndex: 1250,
            background: 'rgba(0,0,0,0.35)', padding: '5vh 6vw',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setPreviewArtifact(null)}
        >
          <div
            style={{
              width: 'min(900px, 90vw)', height: 'min(720px, 88vh)',
              background: 'var(--bg)', borderRadius: 12, overflow: 'hidden',
              boxShadow: '0 18px 48px rgba(0,0,0,0.24)',
              display: 'flex', flexDirection: 'column',
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dialog-header" style={{ padding: '12px 16px' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {previewArtifact.logical_name || previewArtifact.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--meta)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {previewArtifact.path}
                </div>
              </div>
              <Button variant="ghost" onClick={openArtifactDirectory}>
                {t('taskDetail.openDirectory')}
              </Button>
              <Button variant="icon" onClick={() => setPreviewArtifact(null)}>✕</Button>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <ArtifactPreview
                path={previewArtifact.path}
                isDir={!!previewArtifact.is_dir}
                onClose={() => setPreviewArtifact(null)}
              />
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
    </div>
  )
}
