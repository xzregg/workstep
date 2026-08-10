import Button from '../components/Button'
import Input from '../components/Input'
import Textarea from '../components/Textarea'
import {
  useState,
  useEffect,
  useRef,
  useMemo,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
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
import ChatMessageBubble from '../components/ChatMessageBubble'
import ChatInput from '../components/ChatInput'
import MessageMetaBar from '../components/MessageMetaBar'
import MessageResponseFooter, {
  copyMessageText,
  usageFromEvents,
} from '../components/MessageResponseFooter'
import { stripA2uiBlocks } from '../utils/a2ui'
import MarkdownEditor from '../components/MarkdownEditor'
import MarkdownMessage from '../components/MarkdownMessage'
import ProcessTrace from '../components/ProcessTrace'
import Icon from '../components/Icon'
import {
  createOptimisticUserMessage,
  isVisibleHistoryMessage,
  isVisibleLiveExecutionMessage,
  isUnpersistedLiveMessage,
  isTaskCompleted,
  isTaskNotStarted,
  isNearConversationBottom,
  liveExecutionStatus,
  mergeHistoryMessageWithLive,
  orderConversationMessages,
  shouldRenderLegacyExecution,
  stageAvatarText,
} from './taskDetailChat'
import {
  type DateTimeValue,
  formatConversationDateTime,
  formatExecutionClock,
  formatDurationBetween,
  toMilliseconds,
} from '../utils/datetime'
import { useI18n, type TKey } from '../i18n'

const EMPTY_EVENTS: any[] = []
const EMPTY_LIVE_MESSAGES: Record<string, LiveMessage> = {}
const PROCESS_EVENT_TYPES = new Set([
  'thinking_delta',
  'tool_use',
  'tool_input_delta',
  'tool_result',
])

function hasProcessEvents(events: any[]) {
  return events.some((event) => PROCESS_EVENT_TYPES.has(event.type))
}

function terminalMessageStatus(status?: string) {
  return status === 'cancelled' || status === 'stopped' || status === 'failed'
    ? status
    : undefined
}

function lastEventTimestamp(events: any[]): number | null {
  let latest: number | null = null
  for (const event of events || []) {
    const timestamp = toMilliseconds(event?.created_at ?? event?.timestamp)
    if (timestamp !== null && (latest === null || timestamp > latest)) {
      latest = timestamp
    }
  }
  return latest
}

function CoordinatorProposalCard({
  proposal,
  taskId,
  projectId,
  onChanged,
}: {
  proposal: ActionProposal
  taskId: string
  projectId: string
  onChanged: (proposal: ActionProposal) => void
}) {
  const { t } = useI18n()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const current = proposal
  const retryable = current.status === 'failed' && current.type === 'rerun_from_stage'
  const canAct = (current.status === 'pending' || retryable) && !pending

  const confirm = async () => {
    setPending(true)
    setError('')
    try {
      onChanged(await taskApi.confirmAction(
        taskId,
        current.id,
        projectId,
        crypto.randomUUID(),
      ))
    } catch (reason) {
      const fallbackError = reason instanceof Error ? reason.message : t('taskDetail.proposalConfirmFailed')
      try {
        const history = await taskApi.history(taskId, projectId)
        const latest = [...history.messages]
          .reverse()
          .flatMap((message) => message.proposals || [])
          .find((item) => item.id === current.id) as ActionProposal | undefined
        if (latest && latest.status !== 'pending') {
          onChanged(latest)
          setError('')
        } else {
          setError(fallbackError)
        }
      } catch {
        setError(fallbackError)
      }
    } finally {
      setPending(false)
    }
  }

  const cancel = async () => {
    setPending(true)
    setError('')
    try {
      onChanged(await taskApi.cancelAction(taskId, current.id, projectId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('taskDetail.proposalCancelFailed'))
    } finally {
      setPending(false)
    }
  }

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, background: 'var(--bg)', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 700 }}>{t('taskDetail.proposalTitle', { type: current.type })}</div>
      <div style={{ fontSize: 13, color: 'var(--muted)' }}>
        {current.impact?.summary || t('taskDetail.proposalTargetStage', { step: current.target_step_key || t('common.none') })}
      </div>
      <div style={{ fontSize: 11, color: current.status === 'failed' ? 'var(--danger)' : 'var(--meta)' }}>
        {t('taskDetail.proposalStatus', { status: current.status })}{current.error ? ` · ${current.error}` : ''}
      </div>
      {error && <div style={{ fontSize: 11, color: 'var(--danger)' }}>{error}</div>}
      {(current.status === 'pending' || retryable) && (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="primary" disabled={!canAct} loading={pending} onClick={() => void confirm()}>{retryable ? t('common.retry') : t('common.confirm')}</Button>
          {current.status === 'pending' && (
            <Button variant="ghost" disabled={!canAct} onClick={() => void cancel()}>{t('common.cancel')}</Button>
          )}
        </div>
      )}
    </div>
  )
}

const STATUS_LABEL_KEYS: Record<string, TKey> = {
  ready: 'status.ready', running: 'status.running', paused: 'status.paused', stopped: 'status.stopped',
  done: 'status.done',
}

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
  model?: string
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

const STAGE_STATE_LABEL_KEYS: Record<StageVisualState, TKey> = {
  completed: 'status.done',
  current: 'status.current',
  reviewing: 'status.reviewing',
  awaiting_review: 'status.awaiting_review',
  retrying: 'status.retrying',
  rework: 'status.rework',
  rework_waiting: 'status.rework_waiting',
  failed: 'status.failed',
  cancelled: 'status.cancelled',
  skipped: 'status.skipped',
  pending: 'status.pending',
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
  const [stageInserts, setStageInserts] = useState<Array<{
    id: string
    content: string
  }>>([])
  const [editingInsertId, setEditingInsertId] = useState<string | null>(null)
  const [editingInsertContent, setEditingInsertContent] = useState('')
  const [openInsertMenuId, setOpenInsertMenuId] = useState<string | null>(null)
  const [activeCoordinatorMessageId, setActiveCoordinatorMessageId] = useState<string | null>(null)
  const [coordinatorConfig, setCoordinatorConfig] = useState<CoordinatorConfig | null>(null)
  const [coordinatorConfigSaving, setCoordinatorConfigSaving] = useState(false)
  const [coordinatorConfigError, setCoordinatorConfigError] = useState('')
  const [coordinatorConfigNotice, setCoordinatorConfigNotice] = useState('')
  const [proposalOverrides, setProposalOverrides] = useState<Record<string, ActionProposal>>({})
  const [viewingPrompt, setViewingPrompt] = useState<string | null>(null)
  const [livePromptOverrides, setLivePromptOverrides] = useState<Record<string, string>>({})
  const [taskIdCopied, setTaskIdCopied] = useState(false)
  const [durationNowMs, setDurationNowMs] = useState(() => Date.now())
  const [selectedStage, setSelectedStage] = useState(0)
  const selectedStageTaskRef = useRef<string | null>(null)
  const [hasUnreadMessages, setHasUnreadMessages] = useState(false)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLTextAreaElement>(null)
  const shouldFollowMessagesRef = useRef(true)
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
  const [editReviewAuto, setEditReviewAuto] = useState(false)
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
  const contentSplitRef = useRef<HTMLDivElement>(null)
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
  const hasStructuredExecutionMessage = useMemo(
    () => Object.values(liveMessages).some(
      (message) => message.channel === 'execution',
    ) || historyMessages.some(
      (message) => message.channel === 'execution',
    ),
    [historyMessages, liveMessages],
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
    document.body.style.userSelect = 'none'

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

  const beginSplitResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const container = contentSplitRef.current
    if (!container) return
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handleMove = (moveEvent: PointerEvent) => {
      const rect = container.getBoundingClientRect()
      const usableWidth = Math.max(1, rect.width - SPLIT_HANDLE_WIDTH)
      const next = (
        moveEvent.clientX
        - rect.left
        - SPLIT_HANDLE_WIDTH / 2
      ) / usableWidth
      setSplitRatio(clampSplitRatio(next, rect.width))
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

  const resizeSplitWithKeyboard = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const containerWidth = contentSplitRef.current?.clientWidth || panelBounds.width
    const step = event.shiftKey ? 0.08 : 0.025
    setSplitRatio((current) => clampSplitRatio(
      current + (event.key === 'ArrowLeft' ? -step : step),
      containerWidth,
    ))
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

  useEffect(() => {
    if (!taskId || !projectId) {
      setArtifacts([])
      return
    }
    setArtifactsLoading(true)
    taskApi.artifacts(taskId, projectId)
      .then((res) => setArtifacts(res.artifacts || []))
      .catch(() => setArtifacts([]))
      .finally(() => setArtifactsLoading(false))
  }, [taskId, projectId])

  // Fetch tasks if not already loaded
  useEffect(() => {
    if (tasks.length === 0 && projectId) fetchTasks(projectId)
  }, [tasks.length, fetchTasks, projectId])

  useEffect(() => {
    if (historyLoading) return
    if (shouldFollowMessagesRef.current) {
      const container = chatScrollRef.current
      if (container) container.scrollTop = container.scrollHeight
      setHasUnreadMessages(false)
    } else {
      setHasUnreadMessages(true)
    }
  }, [events, content, historyMessages, historyLoading, liveCoordinatorMessages, liveExecutionMessages])

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
    if (steps?.nodes?.length) return steps.nodes.map((n: any) => ({ key: n.type || n.key, label: n.title || n.label, color: n.color || 'var(--meta)', model: n.model || '', prompt: n.prompt || '', inputs: (n.inputs || []).map((i: any) => ({ name: i.name, type: i.type, outputs: i.outputs || [] })), outputs: (n.outputs || []).map((o: any) => ({ name: o.name, type: o.type })) }))
    if (steps?.steps?.length) return steps.steps.map((s: any) => ({ key: s.key || s.id, label: s.label || s.name, color: s.color || 'var(--meta)', model: s.model || '', prompt: s.prompt || '', inputs: (s.inputs || []).map((i: any) => ({ name: i.name || i, type: i.type || 'any', outputs: i.outputs || [] })), outputs: (s.outputs || []).map((o: any) => ({ name: o.name || o, type: o.type || 'any' })) }))
    return [{ key: 'do', label: t('taskList.execute'), color: 'var(--accent)', prompt: '', inputs: [], outputs: [] }]
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

  const visibleStages = useMemo(() => {
    const hideSkipped = (task?.run_round ?? 1) > 1
    const entries = stages.map((stage, index) => ({ stage, index }))
    if (!hideSkipped) return entries
    return entries.filter(
      ({ index }) => stageProgress[index]?.visualState !== 'skipped'
    )
  }, [stages, stageProgress, task?.run_round])

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
    setEditReviewAuto(config?.auto ?? false)
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

  const chatTargetStageKey = chatTarget === 'coordinator' ? null : chatTarget
  const chatTargetStage = chatTargetStageKey !== null
  const targetStage = chatTargetStageKey
    ? runningStages.find((stage) => stage.key === chatTargetStageKey) ?? null
    : null
  const activeStageRunning = targetStage !== null
  const activeStepStatus = stageProgress[activeStageIndex]?.status || 'pending'

  // When a stage engine starts, the input switches to the matching stage tab
  // for direct insert-into-execution messages; when all stages finish it
  // returns to the coordinator Agent. Manual user selection is preserved
  // (only synced on running-state changes).
  useEffect(() => {
    setChatTarget((current) => {
      if (runningStages.length === 0) return 'coordinator'
      if (current !== 'coordinator' && runningStages.some((stage) => stage.key === current)) {
        return current
      }
      return runningStages[0].key
    })
  }, [runningStages])

  const handleRun = async () => {
    if (!taskId || !projectId) return
    if (!chatTargetStage && coordinatorRunning) return
    // Stage mode (Codex-like): sends land in the "Insert message" panel above,
    // then are injected into the running stage after the user confirms.
    if (chatTargetStage) {
      const submittedPrompt = prompt.trim()
      if (!submittedPrompt || !activeStageRunning) return
      setStageInserts((current) => [
        ...current,
        { id: `insert-${crypto.randomUUID()}`, content: submittedPrompt },
      ])
      setPrompt('')
      setChatError('')
      return
    }
    const submittedPrompt = prompt.trim()
    if (!submittedPrompt) return
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

  useEffect(() => {
    if (!openInsertMenuId) return
    const close = () => setOpenInsertMenuId(null)
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [openInsertMenuId])

  const handleEditUserMessage = (content: string) => {
    setPrompt(content)
    chatInputRef.current?.focus()
  }

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
  const time = new Date(task.created_at).toLocaleString(locale)

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

  const findArtifact = (name: string, preferredStepKey?: string) => {
    const normalize = (value: string) =>
      value.toLocaleLowerCase().replace(/[\s_.-]/g, '')
    const normalizedName = normalize(name)
    const candidates = preferredStepKey
      ? artifacts.filter((artifact) => artifact.step_key === preferredStepKey)
      : artifacts
    return candidates.find((artifact) => artifact.logical_name === name)
      || candidates.find((artifact) => {
        const artifactName = normalize(artifact.logical_name || artifact.name)
        return artifactName.includes(normalizedName)
          || normalizedName.includes(artifactName)
      })
  }

  const openArtifact = (name: string, preferredStepKey?: string) => {
    if (artifactsLoading) {
      setArtifactNotice(t('taskDetail.artifactLoading'))
    } else {
      const artifact = findArtifact(name, preferredStepKey)
      if (artifact) {
        setPreviewArtifact(artifact)
        setArtifactNotice('')
        return
      }
      setArtifactNotice(t('taskDetail.artifactNotFound', { name }))
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

      {/* ── Header ── */}
      <div
        role="group"
        tabIndex={0}
        aria-label={t('taskDetail.dragWindowAria')}
        className="task-detail-drag-header"
        onPointerDown={beginPanelMove}
        onKeyDown={moveWithKeyboard}
        onDoubleClick={() => setPanelBounds(initialPanelBounds())}
        title={t('taskDetail.dragWindowTitle')}
        style={{
          padding: '10px',
          borderBottom: '1px solid var(--border-soft)',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          flexShrink: 0,
          cursor: 'move',
          userSelect: 'none',
        }}
      >
        <span className="task-detail-drag-grip" aria-hidden="true">⠿</span>
        <Button variant="icon" onClick={onClose}>←</Button>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.4 }}>{task.title}</span>
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
                minHeight: 22, padding: '0 5px', marginLeft: 'auto', order: 99,
              }}
            >
              {taskIdCopied ? t('common.copied') : `ID: ${task.id}`}
            </Button>
            <span style={{
              display: 'inline-flex', alignItems: 'center', minHeight: 22,
              fontSize: 11, fontWeight: 500, padding: '0 8px', borderRadius: 4, lineHeight: 1,
              background: `color-mix(in oklab, ${activeStageColor}, transparent 85%)`,
              color: activeStageColor,
            }}>
              {t('taskDetail.currentStage', { stage: activeStage.label })}
            </span>
            <span style={{
              display: 'inline-flex', alignItems: 'center', minHeight: 22,
              fontSize: 11, fontWeight: 500, padding: '0 8px', borderRadius: 4, lineHeight: 1,
              background: `color-mix(in oklab, var(--status-${taskCompleted ? 'done' : task.status === 'ready' ? 'ready' : task.status}), transparent 85%)`,
              color: `var(--status-${taskCompleted ? 'done' : task.status === 'ready' ? 'ready' : task.status})`,
            }}>
              {t(STATUS_LABEL_KEYS[taskCompleted ? 'done' : task.status] ?? (task.status as TKey))}
            </span>

            <span style={{ display: 'inline-flex', alignItems: 'center', minHeight: 22, fontSize: 13, lineHeight: 1, color: 'var(--meta)' }}>{time}</span>
          </div>
        </div>
      </div>

      {/* Recovered-after-restart hint */}
      {task.status === 'running' && (task.recovered_count || 0) > 0 && (
        <div
          role="status"
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 16px', fontSize: 13, lineHeight: 1.4,
            color: 'var(--accent)',
            background: 'color-mix(in oklab, var(--accent), transparent 92%)',
            borderBottom: '1px solid var(--border-soft)',
            flexShrink: 0,
          }}
        >
          <span className="task-status-spinner" aria-hidden="true" />
          <span>
            {t('taskDetail.recoveredRunning', {
              count: task.recovered_count && task.recovered_count > 1
                ? t('taskDetail.recoveredCount', { count: task.recovered_count })
                : '',
            })}
          </span>
        </div>
      )}

      {/* ── Content split ── */}
      <div
        ref={contentSplitRef}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: `${splitRatio}fr ${SPLIT_HANDLE_WIDTH}px ${1 - splitRatio}fr`,
          overflow: 'hidden',
        }}
      >
        {/* ── Left panel ── */}
        <div style={{ minWidth: 0, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 24 }}>

          <div>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginBottom: 8,
            }}>
              <div style={{
                fontSize: 11, fontWeight: 600, color: 'var(--muted)', fontFamily: 'var(--font-mono)',
                textTransform: 'uppercase', letterSpacing: '0.08em',
              }}>
                {t('taskDetail.description')}
              </div>
              {!editingDescription && (
                <Button
                  variant="ghost"
                  aria-label={t('taskDetail.editDescriptionAria')}
                  onClick={openDescriptionEditor}
                  style={{ height: 28, padding: '0 9px', fontSize: 11, gap: 4 }}
                >
                  <span aria-hidden="true">✎</span>
                  {t('common.edit')}
                </Button>
              )}
            </div>
            {editingDescription ? (
              <div>
                <MarkdownEditor
                  value={descriptionDraft}
                  onChange={setDescriptionDraft}
                  projectId={projectId}
                  imagePrefix={taskId.slice(0, 8)}
                  placeholder={t('taskDetail.descriptionPlaceholder')}
                  minHeight={140}
                  maxHeight="33vh"
                  disabled={descriptionSaving}
                  autoFocus
                />
                {descriptionError && (
                  <div role="alert" style={{
                    marginTop: 6, color: 'var(--danger)', fontSize: 11,
                  }}>
                    {descriptionError}
                  </div>
                )}
                <div style={{
                  display: 'flex', justifyContent: 'flex-end',
                  gap: 8, marginTop: 8,
                }}>
                  <Button
                    variant="ghost"
                    disabled={descriptionSaving}
                    onClick={() => setEditingDescription(false)}
                  >
                    {t('common.cancel')}
                  </Button>
                  <Button
                    variant="primary"
                    disabled={descriptionSaving}
                    loading={descriptionSaving}
                    onClick={() => void saveDescription()}
                  >
                    {t('common.save')}
                  </Button>
                </div>
              </div>
            ) : (
              <div style={{
                padding: '10px 12px', borderRadius: 8,
                border: '1px solid var(--border-soft)',
                fontSize: 13, lineHeight: 1.6,
                overflowWrap: 'anywhere', maxHeight: '33vh', overflowY: 'auto',
              }}>
                {task.description ? <MarkdownMessage content={task.description} projectId={projectId} /> : <span style={{ color: 'var(--meta)', fontStyle: 'italic' }}>{t('taskDetail.noDescription')}</span>}
              </div>
            )}
          </div>

          {/* Progress timeline */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{t('taskDetail.progress')}</div>
              {(task?.run_round ?? 1) > 1 && (
                <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 999, color: 'var(--accent)', background: 'color-mix(in oklab, var(--accent), transparent 90%)' }}>
                  {t('taskDetail.runRound', { round: task?.run_round ?? 1 })}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 0, position: 'relative' }}>
              {visibleStages.map(({ stage, index: i }, pos) => {
                const progress = stageProgress[i]
                const visualState = progress?.visualState || 'pending'
                const isCompleted = visualState === 'completed'
                const isCurrentActive = [
                  'current', 'reviewing', 'awaiting_review', 'retrying', 'rework', 'rework_waiting',
                ].includes(visualState)
                const isFailed = visualState === 'failed'
                const isCancelled = visualState === 'cancelled'
                const isSkipped = visualState === 'skipped'
                const isSelected = i === selectedStage
                const stageColor = stage.color || 'var(--accent)'
                const stageLabelColor = isSkipped ? 'var(--meta)' : stageColor
                const currentRound = task?.run_round ?? 1
                const restartIndex = stages.findIndex(
                  (item: any) => item.key === task?.restart_from_step_key
                )
                const stageRound = restartIndex >= 0 && i < restartIndex
                  ? Math.max(1, currentRound - 1)
                  : currentRound
                const stageRoundColor = stageRound >= currentRound
                  ? stageColor
                  : 'var(--meta)'
                const finishedDuration = progress?.ended_at
                  ? formatDurationBetween(progress?.started_at, progress.ended_at, t)
                  : null
                const startedAtMs = toMilliseconds(progress?.started_at)
                  ?? toMilliseconds(task.created_at)
                  ?? Date.now()
                const updatedAtMs = toMilliseconds(task.updated_at) ?? Date.now()
                const isDurationLive = task.status === 'running' || [
                  'reviewing', 'awaiting_review', 'retrying', 'rework', 'rework_waiting',
                ].includes(visualState)
                const activeDuration = isCurrentActive && progress?.started_at
                  ? formatDurationBetween(
                      progress.started_at,
                      isDurationLive ? durationNowMs : updatedAtMs,
                      t,
                    )
                  : null
                const activeStateColor = task.status === 'paused'
                  ? 'var(--status-paused)'
                  : task.status === 'stopped'
                    ? 'var(--status-stopped)'
                    : visualState === 'reviewing'
                      ? 'var(--accent)'
                      : ['retrying', 'rework', 'rework_waiting'].includes(visualState)
                        ? 'var(--warn)'
                    : 'var(--status-running)'
                const stateColor = isCompleted
                  ? 'var(--status-done)'
                    : isFailed
                      ? 'var(--status-failed)'
                      : isCancelled
                        ? '#d97706'
                      : isCurrentActive
                      ? activeStateColor
                      : isSkipped
                        ? 'var(--meta)'
                        : 'var(--border)'
                return (
                  <div
                    key={stage.key}
                    role="button"
                    tabIndex={0}
                    aria-label={t('taskDetail.viewStageMessagesAria', { stage: stage.label })}
                    onClick={() => handleStageClick(i)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        handleStageClick(i)
                      }
                    }}
                    style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative', paddingTop: 24, cursor: 'pointer', outline: 'none' }}
                  >
                    {/* Connector line */}
                    <div style={{
                      position: 'absolute', top: 10,
                      left: pos === 0 ? '50%' : 0, right: pos === visibleStages.length - 1 ? '50%' : 0,
                      height: 2, background: stateColor,
                    }} />
                    {/* Dot */}
                    <div style={{
                      width: 20, height: 20, borderRadius: '50%',
                      background: isCompleted || isCurrentActive || isFailed || isCancelled || isSkipped
                        ? stateColor
                        : 'var(--bg)',
                      border: `2px solid ${stateColor}`,
                      position: 'relative', zIndex: 1,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'var(--accent-fg)', fontSize: 13, fontWeight: 700,
                      boxShadow: isSelected
                        ? `0 0 0 4px color-mix(in oklab, ${stageColor}, transparent 72%)`
                        : 'none',
                    }}>
                      {isCompleted ? '✓' : isFailed ? '×' : isCancelled ? '▮' : isSkipped ? '–' : ''}
                    </div>
                    <span style={{
                      fontSize: 13, marginTop: 9, textAlign: 'center', whiteSpace: 'nowrap',
                      color: stageLabelColor,
                      fontWeight: isSelected ? 750 : isCurrentActive ? 650 : 500,
                      padding: '3px 8px', borderRadius: 6,
                      border: isSelected ? `1px solid ${stageColor}` : '1px solid transparent',
                      background: isSelected
                        ? `color-mix(in oklab, ${stageColor}, transparent 88%)`
                        : 'transparent',
                    }}>
                      {stage.label}
                    </span>
                    {visualState !== 'pending' && (
                      <span style={{
                        fontSize: 11, marginTop: 4, padding: '2px 6px',
                        borderRadius: 999,
                        color: stateColor,
                        background: `color-mix(in oklab, ${stateColor}, transparent 88%)`,
                        fontWeight: 600,
                      }}>
                        {t(STAGE_STATE_LABEL_KEYS[visualState])}
                      </span>
                    )}
                    {currentRound > 1 && (
                      <span style={{
                        fontSize: 11, marginTop: 4, padding: '2px 6px',
                        borderRadius: 999,
                        color: stageRoundColor,
                        background: `color-mix(in oklab, ${stageRoundColor}, transparent 88%)`,
                        fontWeight: 600,
                      }}>
                        {t('taskDetail.runRoundShort', { round: stageRound })}
                      </span>
                    )}
                    {finishedDuration && (
                      <div style={{
                        fontSize: 11, color: 'var(--meta)', marginTop: 5,
                        textAlign: 'center', lineHeight: 1.5, whiteSpace: 'nowrap',
                      }}>
                        {t('taskDetail.duration', { duration: finishedDuration })}
                      </div>
                    )}
                    {/* Time info for active stage */}
                    {isCurrentActive && (
                      <div style={{ fontSize: 11, color: 'var(--meta)', marginTop: 5, textAlign: 'center', lineHeight: 1.5 }}>
                        <div>{t('taskDetail.startedAt', { time: new Date(startedAtMs).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) })}</div>
                        {activeDuration && (
                          <span style={{ color: 'var(--fg-2)', fontWeight: 500 }}>
                            {t('taskDetail.duration', { duration: activeDuration })}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Prompt section */}
          <div>
             <div style={{ display: 'flex', flexDirection: 'column', gap: 8 ,color: `${currentStageColor}`}}> {currentStage.label} </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{t('taskDetail.stagePrompt')}</div>
              <Button
                variant="ghost"
                onClick={openPromptEditor}
                style={{ height: 28, padding: '0 9px', fontSize: 13, gap: 4 }}
              >
                <span aria-hidden="true">✎</span>
                {t('taskDetail.quickEdit')}
              </Button>
            </div>
            <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius-sm)', padding: '14px 16px', borderLeft: `3px solid ${currentStageColor}` }}>
              {currentStage.prompt
                ? <MarkdownMessage content={currentStage.prompt} projectId={projectId} />
                : <div style={{ fontSize: 13, color: 'var(--meta)' }}>{t('taskDetail.noStagePrompt')}</div>}
            </div>
          </div>

          {/* I/O section — matching card-detail.html layout */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
              {t('taskDetail.stageIo')}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: 'var(--meta)' }}>→</span> {t('taskDetail.ioInput')}
                </div>
                {(() => {
                  const isStageDone = stageProgress[selectedStage]?.visualState === 'completed'
                  const nextStageIdx = selectedStage + 1
                  const nextStage = nextStageIdx < stages.length ? stages[nextStageIdx] : null
                  const nextInputs = nextStage ? (nextStage.inputs || []) : []
                  // Outputs are attached to the FIRST input only (matching card-detail.html)
                  const stageOutputs = currentStage.outputs || (currentStage.inputs || [])[0]?.outputs || []

                  return (currentStage.inputs || []).map((inp: any, inpIdx: number) => {
                    const subOutputs = inpIdx === 0 ? stageOutputs : []
                    return (
                      <div key={inpIdx} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {/* Input item */}
                        <div
                          role="button"
                          tabIndex={0}
                          aria-label={t('taskDetail.openInputAria', { name: inp.name })}
                          onClick={() => openArtifact(inp.name)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              openArtifact(inp.name)
                            }
                          }}
                          title={t('taskDetail.openFileTitle', { name: inp.name })}
                          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--surface)', borderRadius: 6, border: '1px solid var(--border-soft)', cursor: 'pointer' }}
                        >
                          <div style={{ width: 6, height: 6, borderRadius: '50%', background: currentStageColor, flexShrink: 0 }} />
                          <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{inp.name}</span>
                          <span style={{ fontSize: 11, color: currentStageColor }}>{t('taskDetail.view')}</span>
                          <span style={{ fontSize: 11, color: 'var(--meta)', background: 'var(--surface)', border: '1px solid var(--border-soft)', padding: '0 4px', borderRadius: 3 }}>{inp.type}</span>
                        </div>
                        {/* Sub-outputs (only on first input) */}
                        {subOutputs.map((out: any, outIdx: number) => {
                          const nextInput = nextInputs[outIdx]
                          const statusDone = isStageDone
                          return (
                            <div
                              key={outIdx}
                              role="button"
                              tabIndex={0}
                              aria-label={t('taskDetail.openOutputAria', { name: out.name })}
                              onClick={() => openArtifact(out.name, currentStage.key)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault()
                                  openArtifact(out.name, currentStage.key)
                                }
                              }}
                              title={t('taskDetail.openFileTitle', { name: out.name })}
                              style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 18, padding: '4px 8px', cursor: 'pointer', borderRadius: 4 }}
                            >
                              <span style={{ color: 'var(--meta)', fontSize: 11 }}>↳</span>
                              <div style={{ width: 6, height: 6, borderRadius: '50%', background: statusDone ? 'var(--success)' : currentStageColor, flexShrink: 0 }} />
                              <span style={{ fontSize: 13, flex: 1 }}>{out.name}</span>
                              <span style={{ fontSize: 11, color: currentStageColor }}>{t('common.open')}</span>
                              <span style={{ fontSize: 11, color: 'var(--meta)', background: 'var(--surface)', border: '1px solid var(--border-soft)', padding: '0 3px', borderRadius: 2 }}>{out.type}</span>
                              <span style={{
                                fontSize: 11, fontWeight: 500, padding: '1px 5px', borderRadius: 3,
                                background: statusDone ? 'color-mix(in oklab, var(--success), transparent 85%)' : 'var(--surface)',
                                color: statusDone ? 'var(--success)' : 'var(--meta)',
                                border: statusDone ? 'none' : '1px solid var(--border-soft)',
                              }}>
                                {statusDone ? t('taskDetail.outputDone') : t('taskDetail.outputPending')}
                              </span>
                              {nextInput && (
                                <span style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 2 }}>
                                  <span style={{ color: 'var(--meta)', fontSize: 11 }}>→</span> {nextStage?.label}: {nextInput.name}
                                </span>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )
                  })
                })()}
              </div>
            </div>
          </div>

          {selectedReview && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                {t('taskDetail.reviewResult')}
              </div>
              <div style={{
                border: '1px solid var(--border-soft)', borderRadius: 8,
                background: 'var(--surface)', padding: 12,
                display: 'flex', flexDirection: 'column', gap: 9,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <strong style={{ fontSize: 13 }}>
                    {selectedReview.mode === 'auto' ? t('taskDetail.autoReview') : t('taskDetail.manualReview')}
                  </strong>
                  <span className="status-badge" data-s={
                    selectedReview.status === 'passed'
                      ? 'passed'
                      : selectedReview.status === 'rejected'
                        ? 'failed'
                        : 'paused'
                  }>
                    {selectedReview.status === 'passed'
                      ? t('taskDetail.reviewPassed')
                      : selectedReview.status === 'rejected'
                        ? t('taskDetail.reviewRejected')
                        : selectedReview.status === 'running'
                          ? t('taskDetail.reviewRunning')
                          : t('taskDetail.reviewWaiting')}
                  </span>
                </div>
                {selectedReview.report && (
                  <>
                    <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                      {selectedReview.report.score !== null && (
                        <strong>{t('taskDetail.scorePoints', { score: selectedReview.report.score })}</strong>
                      )}
                      {selectedReview.report.summary}
                    </div>
                    {selectedReview.report.issues.map((issue, index) => (
                      <div key={`${issue.category}-${index}`} style={{
                        fontSize: 11, lineHeight: 1.5, padding: '7px 9px',
                        borderRadius: 6,
                        background: issue.severity === 'error'
                          ? 'color-mix(in oklab, var(--danger), transparent 90%)'
                          : 'color-mix(in oklab, var(--warn), transparent 90%)',
                      }}>
                        <strong>{issue.description}</strong>
                        {issue.suggestion && <div>{issue.suggestion}</div>}
                      </div>
                    ))}
                  </>
                )}
                {(selectedReview.status === 'pending' || selectedReview.status === 'rejected') && (
                  <>
                    <Textarea
                      rows={2}
                      value={reviewComment}
                      onChange={(event) => setReviewComment(event.target.value)}
                      placeholder={t('taskDetail.reviewCommentPlaceholder')}
                    />
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                      {selectedReview.status === 'pending' ? (
                        <>
                          <Button
                            variant="ghost"
                            disabled={reviewActionPending}
                            onClick={() => void decideReview('reject')}
                          >
                            {t('taskDetail.reject')}
                          </Button>
                          <Button
                            variant="primary"
                            disabled={reviewActionPending}
                            loading={reviewActionPending}
                            onClick={() => void decideReview('approve')}
                          >
                            {t('taskDetail.approve')}
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="primary"
                          disabled={reviewActionPending}
                          loading={reviewActionPending}
                          onClick={() => void decideReview('force-approve')}
                        >
                          {t('taskDetail.forceApprove')}
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Per-stage review config (collapsible) */}
          <div style={{ marginTop: 20 }}>
            <button
              onClick={() => setShowReviewDrawer(!showReviewDrawer)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--muted)', fontSize: 11, fontWeight: 600,
                textTransform: 'uppercase', letterSpacing: '0.08em',
                padding: '0', fontFamily: 'var(--font-mono)',
              }}
            >
              <span style={{
                transform: showReviewDrawer ? 'rotate(90deg)' : 'none',
                transition: 'transform 150ms', display: 'inline-block', fontSize: 11,
              }}>&#9654;</span>
              {t('taskDetail.stageReviewConfig')}
            </button>
            {showReviewDrawer && (
              <div style={{
                marginTop: 10, padding: '10px 12px', borderRadius: 6,
                border: '1px solid var(--border)', background: 'var(--surface)',
                display: 'flex', flexDirection: 'column', gap: 8,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={editReviewAuto} onChange={(e) => setEditReviewAuto(e.target.checked)} style={{ accentColor: 'var(--accent)', width: 14, height: 14, margin: 0 }} />
                    {t('taskDetail.autoReview')}
                  </label>
                  <span style={{ fontSize: 13, color: 'var(--meta)' }}>{t('common.retry')}</span>
                  <Input type="number" min={1} max={5} value={editReviewRetries} onChange={(e) => setEditReviewRetries(Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
                    style={{ width: 40, height: 22, fontSize: 13, padding: '0 6px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--fg)' }} />
                </div>
                <MarkdownEditor
                  value={editReviewPrompt}
                  onChange={setEditReviewPrompt}
                  projectId={projectId}
                  placeholder={t('taskDetail.reviewPromptPlaceholder')}
                  minHeight={64}
                  maxHeight={160}
                  ariaLabel={t('taskDetail.reviewPromptAria')}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Button variant="ghost"
                    onClick={async () => {
                      const updated = { ...(task.review_overrides || {}), [currentStage.key]: { auto: editReviewAuto, maxRetries: editReviewRetries, prompt: editReviewPrompt } }
                      await updateTaskDescription(task.id, undefined, projectId!, updated)
                    }}
                    style={{ fontSize: 11, padding: '3px 10px' }}
                  >{t('common.save')}</Button>
                </div>
              </div>
            )}
          </div>

        </div>

        <div
          role="separator"
          tabIndex={0}
          aria-label={t('taskDetail.adjustSplitAria')}
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(splitRatio * 100)}
          className="task-detail-split-handle"
          onPointerDown={beginSplitResize}
          onKeyDown={resizeSplitWithKeyboard}
          onDoubleClick={() => setSplitRatio(DEFAULT_SPLIT_RATIO)}
          title={t('taskDetail.adjustSplitTitle')}
        >
          <span aria-hidden="true" />
        </div>

        {/* ── Right panel: Chat ── */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
          {/* Chat header */}
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-soft)', background: 'var(--bg)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>{t('taskDetail.conversation')}</span>
            <span style={{ fontSize: 11, fontWeight: 600, color: currentStageColor, background: `color-mix(in oklab, ${currentStageColor}, transparent 88%)`, padding: '2px 8px', borderRadius: 4 }}>
              {currentStage.label}
            </span>
          </div>
          {/* Chat messages */}
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }}>
          <div
            ref={chatScrollRef}
            onScroll={(event) => {
              const container = event.currentTarget
              const nearBottom = isNearConversationBottom(
                container.scrollHeight,
                container.scrollTop,
                container.clientHeight,
              )
              shouldFollowMessagesRef.current = nearBottom
              if (nearBottom) setHasUnreadMessages(false)
            }}
            style={{ height: '100%', minWidth: 0, overflowY: 'auto', overflowX: 'hidden', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}
          >
            {historyLoading && (
              <div style={{ textAlign: 'center', color: 'var(--meta)', padding: 20, fontSize: 13 }}>{t('common.loading')}</div>
            )}

            {!historyLoading && historyMessages.length === 0 && events.length === 0 && !content && liveCoordinatorMessages.length === 0 && !running && (
              <div style={{ textAlign: 'center', color: 'var(--meta)', padding: 40, fontSize: 13 }}>
                {t('taskDetail.conversationEmpty')}
              </div>
            )}

            {/* Conversation messages in persistent task sequence order
                (history merged with live execution segments, so an inserted
                message lands between the pre-insert stage output and the
                stage's follow-up response, like Codex segments). */}
            {(() => {
              const orderedMessagesRaw = [
                ...historyMessages
                .filter(isVisibleHistoryMessage)
                .map((message: any) => mergeHistoryMessageWithLive(
                  message,
                  liveMessages[String(message.id)],
                )),
                // Unpersisted live execution messages (segment A / response B)
                // are sorted with history so inserts land between stage outputs.
                ...liveExecutionMessages.map((message: any) => ({
                  ...message,
                  run_status: message.status,
                  ended_at: message.status === 'running'
                    ? undefined
                    : lastEventTimestamp(message.events),
                })),
              ]
              const orderedMessages = orderConversationMessages(orderedMessagesRaw, durationNowMs)
              return orderedMessages.map((message: any) => {
                const stageKey = message.context_step_key || message.step_key || 'unknown'
                const msgs = [message]
                const stageInfo = stages.find((s: any) => s.key === stageKey)
                const stageLabel = message.channel === 'coordinator'
                  ? t('aiFlow.agent')
                  : stageInfo?.label || stageKey
                return (
                  <div key={message.id} style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {/* Messages in this stage */}
                    {msgs.map((msg: any, i: number) => {
                      const isUser = msg.role === 'user'
                      const isSystem = msg.role === 'system'
                      const isReview = msg.channel === 'review' || msg.role === 'review'
                      const isCoordinator = msg.channel === 'coordinator'
                      const isLiveInsert = !isCoordinator && msg.role === 'user'
                        && msg.run_id === msg.id
                      const processEvents = Array.isArray(msg.events) ? msg.events : []
                      const sender = isUser
                        ? t('aiFlow.me')
                        : isSystem
                          ? t('taskDetail.system')
                          : isCoordinator
                            ? t('aiFlow.agent')
                            : stageLabel
                      const initials = isUser || isSystem
                          ? sender.slice(0, 2)
                          : isCoordinator
                            ? t('aiFlow.agentInitials')
                          : stageAvatarText(stageLabel, t)
                      const senderColor = isUser
                        ? 'var(--accent)'
                        : isSystem
                          ? 'var(--warn)'
                          : isReview
                            ? (stageInfo?.color || 'var(--warn)')
                          : isCoordinator
                            ? 'var(--ai-assistant)'
                            : (stageInfo?.color || 'var(--fg)')

                      return (
                        <ChatMessageBubble
                          key={i}
                          role={isSystem ? 'system' : isReview ? 'review' : (isUser ? 'user' : 'assistant')}
                          sender={sender}
                          initials={initials}
                          color={senderColor}
                          content={msg.content || ''}
                          streaming={msg.run_status === 'running'}
                          badge={isReview ? <span title="Review" aria-label={t('taskDetail.reviewBadgeAria')}>R</span> : undefined}
                          onEdit={isUser ? handleEditUserMessage : undefined}
                          rootProps={{
                            ref: i === msgs.length - 1
                              ? (element) => {
                                  stageLastMessageRefs.current[stageKey] = element
                                }
                              : undefined,
                            'data-stage-last-message': i === msgs.length - 1 ? stageKey : undefined,
                          }}
                          header={isUser ? (
                            <>
                              <span
                                title={isCoordinator
                                  ? t('taskDetail.sendToCoordinatorTitle')
                                  : isLiveInsert
                                    ? t('taskDetail.liveInsertTitle')
                                    : t('taskDetail.stageInitialInputTitle')}
                                style={{
                                  padding: '1px 6px', borderRadius: 999, fontSize: 11,
                                  border: isLiveInsert ? 'none' : '1px solid var(--border-soft)',
                                  background: isCoordinator
                                    ? 'rgba(124,58,237,0.08)'
                                    : isLiveInsert
                                      ? 'var(--accent)'
                                      : 'rgba(0,113,227,0.08)',
                                  color: isCoordinator
                                    ? 'var(--ai-assistant)'
                                    : isLiveInsert ? 'var(--accent-fg)' : 'var(--accent)',
                                }}
                              >
                                {isCoordinator ? t('taskDetail.coordinatorTag') : `@${stageLabel}`}
                              </span>
                              {isCoordinator
                                ? formatConversationDateTime(msg.started_at || msg.created_at, Date.now(), locale)
                                : formatExecutionClock(msg.started_at || msg.created_at)}
                            </>
                          ) : (
                            <MessageMetaBar
                              createdAt={msg.created_at}
                              startedAt={msg.started_at}
                              endedAt={msg.ended_at}
                              running={msg.run_status === 'running'}
                              events={processEvents}
                              prompt={msg.prompt}
                              sessionId={isCoordinator
                                ? (task?.coordinator_session_id || null)
                                : isReview
                                  ? undefined
                                  : sessionIdForStep(stageKey)}
                              onViewPrompt={setViewingPrompt}
                              origin={isCoordinator ? undefined : executionOrigin}
                              status={terminalMessageStatus(msg.run_status)}
                            />
                          )}
                          showLoading={!isUser && !isCoordinator && msg.run_status === 'running' && !msg.content}
                          loading={!isUser && msg.run_status === 'running'
                            ? (
                              <div className="engine-loading-message" role="status" aria-live="polite">
                                <span>{liveExecutionStatus(processEvents, t)}</span>
                                <span className="engine-loading-dots" aria-hidden="true">
                                  <i />
                                  <i />
                                  <i />
                                </span>
                              </div>
                            )
                            : undefined}
                          footer={!isUser && !isSystem && msg.content
                            && !(isReview && !msg.engine)
                            ? (
                              <MessageResponseFooter
                                content={stripA2uiBlocks(String(msg.content))}
                                usage={msg.usage || usageFromEvents(processEvents)}
                                engine={msg.engine}
                                model={msg.model}
                                executionModel={isCoordinator ? undefined : executionStageModel}
                                endedAt={msg.ended_at}
                                running={msg.run_status === 'running'}
                                stopped={!isCoordinator && (msg.run_status === 'cancelled' || msg.run_status === 'stopped')}
                                onContinueStage={!isCoordinator && taskId
                                  ? () => void runTask(taskId, '', projectId)
                                  : undefined}
                              />
                            )
                            : undefined}
                        >
                          {(msg.proposals || []).map((proposal: ActionProposal) => {
                            const currentProposal = proposalOverrides[proposal.id] || proposal
                            return (
                              <CoordinatorProposalCard
                                key={proposal.id}
                                proposal={currentProposal}
                                taskId={taskId || ''}
                                projectId={projectId}
                                onChanged={(updated) => setProposalOverrides((current) => ({
                                  ...current,
                                  [updated.id]: updated,
                                }))}
                              />
                            )
                          })}
                        </ChatMessageBubble>
                      )
                    })}
                  </div>
                )
              })
            })()}

            {liveCoordinatorMessages.map((message) => (
              <ChatMessageBubble
                key={message.id}
                role="assistant"
                sender={t('aiFlow.agent')}
                initials={t('aiFlow.agentInitials')}
                color="var(--ai-assistant)"
                content={message.content || ''}
                streaming={message.status === 'running'}
                variant="bg"
                header={
                  <MessageMetaBar
                    createdAt={message.created_at}
                    running={message.status === 'running'}
                    events={message.events}
                    prompt={message.prompt || livePromptOverrides[message.id]}
                    sessionId={task?.coordinator_session_id || sessionIdForStep(message.step_key)}
                    onViewPrompt={setViewingPrompt}
                    status={terminalMessageStatus(message.status)}
                  />
                }
                showLoading={!message.content && message.status === 'running'}
                loading={
                  <div className="engine-loading-message" role="status">{t('aiFlow.thinking')}</div>
                }
                footer={message.content ? (
                  <MessageResponseFooter
                    content={stripA2uiBlocks(message.content)}
                    usage={usageFromEvents(message.events)}
                    engine={message.engine}
                    model={message.model}
                    endedAt={message.status === 'running'
                      ? undefined
                      : lastEventTimestamp(message.events)}
                    running={message.status === 'running'}
                  />
                ) : undefined}
              >
                {message.proposals.map((rawProposal) => {
                  const proposal = rawProposal as unknown as ActionProposal
                  const currentProposal = proposalOverrides[proposal.id] || proposal
                  return (
                    <CoordinatorProposalCard
                      key={proposal.id}
                      proposal={currentProposal}
                      taskId={taskId || ''}
                      projectId={projectId}
                      onChanged={(updated) => setProposalOverrides((current) => ({
                        ...current,
                        [updated.id]: updated,
                      }))}
                    />
                  )
                })}
              </ChatMessageBubble>
            ))}

            {/* Live assistant process and response */}
            {shouldRenderLegacyExecution(
              running,
              hasProcessEvents(events),
              content,
              hasStructuredExecutionMessage,
            ) && (
              <ChatMessageBubble
                role="assistant"
                sender={activeStage.label}
                initials={stageAvatarText(activeStage.label, t)}
                color={activeStageColor}
                content={content}
                streaming={running}
                variant="bg"
                header={<ProcessTrace events={events} running={running} />}
                showLoading={running && !content && !hasProcessEvents(events)}
                loading={
                  <div className="engine-loading-message" role="status" aria-live="polite">
                    <span>{t('chat.processing')}</span>
                    <span className="engine-loading-dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                }
                footer={content ? (
                  <MessageResponseFooter
                    content={stripA2uiBlocks(content)}
                    usage={usageFromEvents(events)}
                    engine={task.engine}
                    model={task.model}
                    executionModel={executionStageModel}
                    endedAt={running ? undefined : lastEventTimestamp(events)}
                    running={running}
                  />
                ) : undefined}
              />
            )}

            <div ref={chatEndRef} />
          </div>
          {hasUnreadMessages && (
            <button
              type="button"
              onClick={() => {
                shouldFollowMessagesRef.current = true
                setHasUnreadMessages(false)
                const container = chatScrollRef.current
                if (container) container.scrollTop = container.scrollHeight
              }}
              aria-label={t('taskDetail.viewNewMessagesAria')}
              style={{
                position: 'absolute', right: 12, bottom: 12, zIndex: 2,
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '6px 10px', borderRadius: 999,
                border: '1px solid color-mix(in oklab, var(--accent), transparent 55%)',
                background: 'var(--bg)', color: 'var(--accent)',
                boxShadow: '0 3px 12px rgba(0,0,0,0.14)',
                fontSize: 11, fontWeight: 600, cursor: 'pointer',
              }}
            >
              {t('taskDetail.newMessages')} <span aria-hidden="true">↓</span>
            </button>
          )}
          </div>

          {/* Chat input */}
          <div style={{ position: 'relative', padding: '14px 20px', borderTop: '1px solid var(--border-soft)', background: 'var(--bg)', display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0 }}>
            {chatTargetStage && activeStageRunning && targetStage && stageInserts.length > 0 && (
              <div role="region" aria-label={t('taskDetail.insertMessages')} style={{
                position: 'absolute', bottom: '100%', left: 20, right: 20,
                marginBottom: 6, zIndex: 30,
                borderRadius: 8, border: '1px solid var(--border-soft)',
                background: 'var(--bg)',
                boxShadow: '0 2px 12px rgba(0,0,0,0.12)',
                padding: '6px 10px',
                display: 'flex', flexDirection: 'column', gap: 4,
              }}>
                <div
                  title={t('taskDetail.insertMessagesTitle', { stage: targetStage.label })}
                  style={{ fontSize: 11, fontWeight: 600, color: 'var(--meta)', display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  {t('taskDetail.insertMessages')}
                  <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--muted)' }}>
                    {t('taskDetail.itemCount', { count: stageInserts.length })}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 400, color: 'var(--muted)' }}>
                    @{targetStage.label}
                  </span>
                </div>
                {stageInserts.map((insert) => (
                  <div key={insert.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '4px 6px', borderRadius: 6,
                    position: 'relative',
                  }}>
                    {editingInsertId === insert.id ? (
                      <Textarea
                        autoFocus
                        value={editingInsertContent}
                        onChange={(e) => setEditingInsertContent(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            handleStageInsertEditSave(insert.id)
                          }
                          if (e.key === 'Escape') {
                            e.preventDefault()
                            handleStageInsertEditCancel()
                          }
                        }}
                        rows={2}
                        style={{
                          flex: 1, minWidth: 0, fontSize: 11, lineHeight: 1.4,
                          color: 'var(--fg)', background: 'var(--bg)',
                          border: '1px solid var(--accent)', borderRadius: 6,
                          padding: '4px 6px', outline: 'none', resize: 'none',
                          fontFamily: 'var(--font-body)',
                        }}
                      />
                    ) : (
                      <>
                        <Icon name="list" size={12} strokeWidth={1.6} color="var(--muted)" style={{ flexShrink: 0, opacity: 0.7 }} />
                        <div style={{
                          flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.4,
                          color: 'var(--fg)',
                          whiteSpace: 'nowrap', overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}>
                          {insert.content}
                        </div>
                      </>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                      {editingInsertId === insert.id ? (
                        <>
                          <button
                            type="button"
                            onClick={() => handleStageInsertEditSave(insert.id)}
                            title={t('taskDetail.saveEditTitle')}
                            style={{
                              padding: '2px 8px', borderRadius: 6, fontSize: 11,
                              border: 'none', background: 'var(--accent)', color: 'var(--accent-fg)',
                              cursor: 'pointer',
                            }}
                          >
                            {t('common.save')}
                          </button>
                          <button
                            type="button"
                            onClick={handleStageInsertEditCancel}
                            title={t('taskDetail.cancelEditTitle')}
                            style={{
                              padding: '2px 8px', borderRadius: 6, fontSize: 11,
                              border: '1px solid var(--border)',
                              background: 'transparent', color: 'var(--meta)',
                              cursor: 'pointer',
                            }}
                          >
                            {t('common.cancel')}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => handleStageInsertSend(insert)}
                            title={t('taskDetail.sendInsertTitle')}
                            style={{
                              padding: '2px 6px', fontSize: 11,
                              border: 'none', background: 'transparent',
                              color: 'var(--accent)', cursor: 'pointer',
                            }}
                          >
                            {t('chatInput.send')}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleStageInsertEditStart(insert)}
                            title={t('taskDetail.editInsertTitle')}
                            style={{
                              padding: '4px', border: 'none', background: 'transparent',
                              color: 'var(--muted)', cursor: 'pointer',
                              display: 'flex', alignItems: 'center', borderRadius: 4,
                            }}
                          >
                            <Icon name="pencil" size={12} strokeWidth={2} />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleStageInsertRemove(insert.id)}
                            title={t('taskDetail.deleteInsertTitle')}
                            style={{
                              padding: '4px', border: 'none', background: 'transparent',
                              color: 'var(--muted)', cursor: 'pointer',
                              display: 'flex', alignItems: 'center', borderRadius: 4,
                            }}
                          >
                            <Icon name="trash" size={12} strokeWidth={2} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
                {stageInserts.length > 1 && (
                  <div style={{
                    display: 'flex', justifyContent: 'flex-end', gap: 6,
                    paddingTop: 4, borderTop: '1px solid var(--border-soft)',
                  }}>
                    <button
                      type="button"
                      onClick={handleSendAllInserts}
                      title={t('taskDetail.sendAllTitle')}
                      style={{
                        padding: '2px 8px', fontSize: 11, borderRadius: 6,
                        border: 'none', background: 'var(--accent)', color: 'var(--accent-fg)',
                        cursor: 'pointer',
                      }}
                    >
                      {t('taskDetail.sendAll', { count: stageInserts.length })}
                    </button>
                    <button
                      type="button"
                      onClick={() => setStageInserts([])}
                      title={t('taskDetail.clearAllTitle')}
                      style={{
                        padding: '2px 8px', fontSize: 11, borderRadius: 6,
                        border: '1px solid var(--border)',
                        background: 'transparent', color: 'var(--meta)',
                        cursor: 'pointer',
                      }}
                    >
                      {t('taskDetail.clearAll')}
                    </button>
                  </div>
                )}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 8, background: 'var(--bg-soft, rgba(128,128,128,0.08))', border: '1px solid var(--border-soft)' }}>
                <button
                  type="button"
                  onClick={() => setChatTarget('coordinator')}
                  aria-pressed={chatTarget === 'coordinator'}
                  title={t('taskDetail.coordinatorTabTitle')}
                  style={{
                    padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                    border: 'none', cursor: 'pointer',
                    background: chatTargetStage ? 'transparent' : 'var(--accent)',
                    color: chatTargetStage ? 'var(--meta)' : 'var(--accent-fg)',
                  }}
                >
                  {t('aiFlow.agent')}
                </button>
                {runningStages.map((stage) => (
                  <button
                    key={stage.key}
                    type="button"
                    onClick={() => setChatTarget(stage.key)}
                    aria-pressed={chatTarget === stage.key}
                    title={t('taskDetail.stageTabTitle', { stage: stage.label })}
                    style={{
                      padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                      border: 'none', cursor: 'pointer',
                      background: chatTarget === stage.key ? 'var(--accent)' : 'transparent',
                      color: chatTarget === stage.key ? 'var(--accent-fg)' : 'var(--meta)',
                      maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {stage.label}
                  </button>
                ))}
              </div>
              {chatTargetStage && activeStageRunning && targetStage && (
                <span style={{ fontSize: 11, color: 'var(--meta)' }}>
                  {t('taskDetail.enterHint', { stage: targetStage.label })}
                </span>
              )}
              {chatTargetStage && !activeStageRunning && (
                <span style={{ fontSize: 11, color: 'var(--warn)' }}>
                  {t('taskDetail.stageNotRunningHint')}
                </span>
              )}
            </div>
            {chatError && (
              <div role="alert" style={{
                fontSize: 13, color: 'var(--danger)', padding: '6px 10px',
                borderRadius: 6, border: '1px solid rgba(217,45,32,0.25)',
                background: 'rgba(217,45,32,0.06)',
              }}>
                {chatError}
              </div>
            )}
            <ChatInput
              value={prompt}
              onChange={setPrompt}
              onSend={handleRun}
              inputRef={chatInputRef}
              imageAttach={projectId ? {
                projectId,
                prefix: taskId?.slice(0, 8) ?? '',
                onError: (message) => setChatError(message),
              } : undefined}
              stopTitle={chatTargetStage ? t('taskDetail.stopStageTitle') : t('chatInput.stopGenerating')}
              config={{
                engines: coordinatorConfig?.available_engines || [],
                engine: coordinatorConfig?.configured.engine || '',
                defaultEngine: coordinatorConfig?.resolved.engine || task.coordinator_engine || task.engine || 'claude',
                model: coordinatorConfig?.configured.model || '',
                fastModel: coordinatorConfig?.configured.fast_model || '',
                visionModel: coordinatorConfig?.configured.vision_model || '',
                showVision: true,
                disabled: !coordinatorConfig || coordinatorRunning,
                saving: coordinatorConfigSaving,
                error: coordinatorConfigError,
                notice: coordinatorConfigNotice,
                hint: coordinatorConfig ? t('taskDetail.hintFromNextMessage') : '',
                engineTitle: t('taskDetail.engineTitle'),
                onEngineChange: (engineId) => void handleCoordinatorEngineChange(engineId),
                onModelChange: (model) => void handleCoordinatorModelChange(model),
                onFastModelChange: (fastModel) => void handleCoordinatorFastModelChange(fastModel),
                onVisionModelChange: (visionModel) => void handleCoordinatorVisionModelChange(visionModel),
                onReset: () => void handleCoordinatorEngineChange(''),
              }}
              disabled={chatTargetStage ? false : coordinatorRunning}
              running={(chatTargetStage && activeStageRunning && prompt.trim().length === 0)
                || (!chatTargetStage && coordinatorRunning)}
              stopping={(chatTargetStage && targetStage
                ? stoppingStepKeys.includes(targetStage.key)
                : false)
                || (!chatTargetStage && coordinatorStopping)}
              onStop={chatTargetStage && targetStage
                ? () => void handleStopStage(targetStage.key)
                : handleStopCoordinator}
              placeholder={chatTargetStage && targetStage
                ? t('taskDetail.stagePlaceholder', { stage: targetStage.label })
                : coordinatorRunning
                  ? t('taskDetail.coordinatorProcessing')
                  : t('taskDetail.coordinatorPlaceholder')}
              title={chatTargetStage
                ? t('taskDetail.stageInputTitle')
                : coordinatorRunning ? t('taskDetail.stopCoordinatorTitle') : t('taskDetail.sendToCoordinator')}
            />
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
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
              <ArtifactPreview path={previewArtifact.path} onClose={() => setPreviewArtifact(null)} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
