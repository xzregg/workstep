import Icon from '../components/Icon'
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
import MarkdownEditor from '../components/MarkdownEditor'
import MarkdownMessage from '../components/MarkdownMessage'
import ProcessTrace from '../components/ProcessTrace'
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
  shouldRenderLegacyExecution,
  stageAvatarText,
} from './taskDetailChat'
import {
  type DateTimeValue,
  formatConversationDateTime,
  formatExecutionOffset,
  formatDurationBetween,
  toMilliseconds,
} from '../utils/datetime'

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

function StageStopButton({
  stepKey,
  onStop,
}: {
  stepKey?: string
  onStop: (stepKey: string) => void
}) {
  const targetStepKey = stepKey || ''
  return (
    <button
      type="button"
      onClick={() => onStop(targetStepKey)}
      title="停止当前阶段执行"
      aria-label="停止当前阶段执行"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '2px 8px', borderRadius: 999, fontSize: 11,
        border: '1px solid rgba(217,45,32,0.4)',
        background: 'transparent', color: '#d92d20',
        cursor: 'pointer', whiteSpace: 'nowrap',
      }}
    >
      <Icon name="stop" size={8} fill />
      停止
    </button>
  )
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
      const fallbackError = reason instanceof Error ? reason.message : '确认失败'
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
      setError(reason instanceof Error ? reason.message : '取消失败')
    } finally {
      setPending(false)
    }
  }

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, background: 'var(--bg)', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 700 }}>协调动作 · {current.type}</div>
      <div style={{ fontSize: 13, color: 'var(--muted)' }}>
        {current.impact?.summary || `目标阶段：${current.target_step_key || '无'}`}
      </div>
      <div style={{ fontSize: 11, color: current.status === 'failed' ? 'var(--danger)' : 'var(--meta)' }}>
        状态：{current.status}{current.error ? ` · ${current.error}` : ''}
      </div>
      {error && <div style={{ fontSize: 11, color: 'var(--danger)' }}>{error}</div>}
      {(current.status === 'pending' || retryable) && (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="primary" disabled={!canAct} loading={pending} onClick={() => void confirm()}>{retryable ? '重试' : '确认'}</Button>
          {current.status === 'pending' && (
            <Button variant="ghost" disabled={!canAct} onClick={() => void cancel()}>取消</Button>
          )}
        </div>
      )}
    </div>
  )
}

const STATUS_LABELS: Record<string, string> = {
  ready: '预备中', running: '开始', paused: '暂停', stopped: '停止',
  done: '已完成',
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

const STAGE_STATE_LABELS: Record<StageVisualState, string> = {
  completed: '已完成',
  current: '当前',
  reviewing: '审核中',
  awaiting_review: '等待审核',
  retrying: '自动重跑',
  rework: '返工中',
  rework_waiting: '等待返工',
  failed: '失败',
  skipped: '已跳过',
  pending: '待处理',
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
const RESIZE_LABELS: Record<ResizeEdge, string> = {
  n: '调整任务详情上边界',
  e: '调整任务详情右边界',
  s: '调整任务详情下边界',
  w: '调整任务详情左边界',
  ne: '调整任务详情右上角',
  nw: '调整任务详情左上角',
  se: '调整任务详情右下角',
  sw: '调整任务详情左下角',
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
  const [chatTarget, setChatTarget] = useState<'stage' | 'coordinator'>('coordinator')
  const [chatError, setChatError] = useState('')
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
        reason instanceof Error ? reason.message : '协调引擎加载失败',
      ))
  }, [taskId, projectId])

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
    return [{ key: 'do', label: '执行', color: 'var(--accent)', prompt: '', inputs: [], outputs: [] }]
  }, [activeProject?.steps])

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

  const activeStepStatus = stageProgress[activeStageIndex]?.status || 'pending'
  const activeStageRunning = activeStepStatus === 'running'
  const chatTargetStage = chatTarget === 'stage'

  // 阶段引擎开始执行时，输入框自动切换到「阶段 Agent」，可直接发消息插入执行；
  // 阶段结束后切回「协调 Agent」。用户手动切换的选择不会被中途覆盖（仅在运行状态变化时同步）。
  useEffect(() => {
    setChatTarget(activeStageRunning ? 'stage' : 'coordinator')
  }, [activeStageRunning])

  const handleRun = async () => {
    if (!taskId || !projectId) return
    if (!chatTargetStage && coordinatorRunning) return
    // 阶段模式：像 Codex 一样，发送即进入上方的「插入消息」面板，
    // 由用户决定「发送 / 加入引导 / 删除」后再实时注入执行。
    if (chatTargetStage) {
      if (prompt.trim()) {
        setStageInserts((current) => [
          ...current,
          { id: `insert-${crypto.randomUUID()}`, content: prompt.trim() },
        ])
        setPrompt('')
        setChatError('')
      }
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
      setChatError(reason instanceof Error ? reason.message : '发送失败')
    }
  }

  const handleStopCoordinator = async () => {
    if (!taskId || !projectId) return
    setChatError('')
    try {
      const result = await taskApi.stopCoordinator(taskId, projectId)
      if (!result.stopped) {
        // 没有正在运行的 turn（可能刚好结束），事件会自然收尾。
        setCoordinatorRunning(false)
        setActiveCoordinatorMessageId(null)
        taskApi.history(taskId, projectId)
          .then((res) => setHistoryMessages(res.messages || []))
          .catch(() => undefined)
      }
    } catch (reason) {
      setChatError(reason instanceof Error ? reason.message : '停止失败')
    }
  }

  const handleStopStage = async (stepKey: string) => {
    if (!taskId || !projectId) return
    setChatError('')
    try {
      await taskApi.cancelStep(taskId, stepKey, projectId)
    } catch (reason) {
      setChatError(reason instanceof Error ? reason.message : '停止失败')
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

  useEffect(() => {
    if (!openInsertMenuId) return
    const close = () => setOpenInsertMenuId(null)
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [openInsertMenuId])

  const sendStageInserts = async (
    items: Array<{ id: string; content: string }>,
    asGuidance: boolean,
  ) => {
    if (!taskId || !projectId || !activeStageRunning) return
    if (!items.length) return
    const submitted = items.map((item) => item.content).join('\n\n')
    setChatError('')
    const optimisticId = `pending-${crypto.randomUUID()}`
    const optimisticMessage = createOptimisticUserMessage(
      optimisticId,
      submitted,
      activeStage.key,
      new Date().toISOString(),
    )
    setHistoryMessages((current) => [...current, optimisticMessage])
    setStageInserts((current) => current.filter(
      (item) => !items.some((target) => target.id === item.id)
    ))
    try {
      const accepted = await taskApi.sendStageMessage(
        taskId,
        activeStage.key,
        submitted,
        projectId,
        asGuidance,
      )
      setHistoryMessages((current) => current.map((message) => (
        message.id === optimisticId
          ? {
              ...message,
              id: accepted.message_id,
              channel: 'execution',
              run_status: 'completed',
            }
            : message
      )))
    } catch (reason) {
      setHistoryMessages((current) => current.filter(
        (message) => message.id !== optimisticId
      ))
      setChatError(reason instanceof Error ? reason.message : '发送失败')
    }
  }

  const handleStageInsertSend = (insert: { id: string; content: string }) => {
    void sendStageInserts([insert], false)
  }

  const handleStageInsertGuidance = (insert: { id: string; content: string }) => {
    void sendStageInserts([insert], true)
  }

  const handleSendAllInserts = () => {
    void sendStageInserts(stageInserts, false)
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
      setCoordinatorConfigNotice('已保存，将从下一条协调消息生效')
    } catch (reason) {
      setCoordinatorConfigError(
        reason instanceof Error ? reason.message : '协调引擎切换失败',
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
      setCoordinatorConfigNotice('已保存，将从下一条协调消息生效')
    } catch (reason) {
      setCoordinatorConfigError(
        reason instanceof Error ? reason.message : '协调模型切换失败',
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
      setCoordinatorConfigNotice('已保存，将从下一条协调消息生效')
    } catch (reason) {
      setCoordinatorConfigError(
        reason instanceof Error ? reason.message : '协调快速模型切换失败',
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
      setCoordinatorConfigNotice('已保存，将从下一条协调消息生效')
    } catch (reason) {
      setCoordinatorConfigError(
        reason instanceof Error ? reason.message : '协调图片理解模型切换失败',
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
        任务未找到
        <br />
        <Button variant="ghost" style={{ marginTop: 12 }} onClick={onClose}>← 返回</Button>
      </div>
    )
  }

  const currentStageColor = currentStage.color || 'var(--accent)'
  const activeStageColor = activeStage.color || 'var(--accent)'
  const selectedReview = reviews.find((review) => review.step_key === currentStage.key)
  const activeReview = reviews.find((review) => review.step_key === activeStage.key)
  const time = new Date(task.created_at).toLocaleString('zh-CN')

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
        error instanceof Error ? error.message : '任务说明保存失败'
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
        `保存失败：${error instanceof Error ? error.message : '未知错误'}`
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
        label: running ? '启动中…' : '开始',
        disabled: running,
      }
    }
    if (
      task.status === 'ready'
      && task.steps.every(
        (step) => step.status === 'passed' || step.status === 'skipped'
      )
    ) {
      return { label: '工作流已完成', disabled: true }
    }
    if (activeStepStatus === 'awaiting_review') {
      return {
        label: '审核通过并进入下一阶段',
        disabled: reviewActionPending || !activeReview,
      }
    }
    if (activeStepStatus === 'rejected') {
      return {
        label: '跳过审核并进入下一阶段',
        disabled: reviewActionPending || !activeReview,
      }
    }
    if (activeStepStatus === 'reviewing') {
      return { label: '审核中…', disabled: true }
    }
    if (activeStepStatus === 'retrying') {
      return { label: '自动重跑中…', disabled: true }
    }
    if (activeStepStatus === 'running') {
      return { label: '当前阶段执行中…', disabled: true }
    }
    return { label: '等待当前阶段完成', disabled: true }
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
      setArtifactNotice('产物正在加载，请稍后再试')
    } else {
      const artifact = findArtifact(name, preferredStepKey)
      if (artifact) {
        setPreviewArtifact(artifact)
        setArtifactNotice('')
        return
      }
      setArtifactNotice(`未找到“${name}”对应的产物文件`)
    }
    setTimeout(() => setArtifactNotice(''), 3000)
  }

  const openArtifactDirectory = async () => {
    if (!previewArtifact) return
    try {
      const result = await fsApi.openDirectory(previewArtifact.path)
      setArtifactNotice(`已打开目录：${result.path}`)
    } catch (error) {
      setArtifactNotice(
        `打开目录失败：${error instanceof Error ? error.message : '未知错误'}`
      )
    }
    setTimeout(() => setArtifactNotice(''), 3000)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`任务详情 ${task.title}`}
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
          aria-label={RESIZE_LABELS[edge]}
          className={`task-detail-resize-handle task-detail-resize-${edge}`}
          onPointerDown={(event) => beginPanelResize(edge, event)}
          onKeyDown={(event) => resizeWithKeyboard(edge, event)}
        />
      ))}

      {/* ── Header ── */}
      <div
        role="group"
        tabIndex={0}
        aria-label="拖动任务详情窗口"
        className="task-detail-drag-header"
        onPointerDown={beginPanelMove}
        onKeyDown={moveWithKeyboard}
        onDoubleClick={() => setPanelBounds(initialPanelBounds())}
        title="拖动移动任务详情，双击恢复默认大小"
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
            <button
              type="button"
              className="btn-ghost"
              title="点击复制任务 ID"
              aria-label="复制任务 ID"
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
              {taskIdCopied ? '已复制' : `ID: ${task.id}`}
            </button>
            <span style={{
              display: 'inline-flex', alignItems: 'center', minHeight: 22,
              fontSize: 11, fontWeight: 500, padding: '0 8px', borderRadius: 4, lineHeight: 1,
              background: `color-mix(in oklab, ${activeStageColor}, transparent 85%)`,
              color: activeStageColor,
            }}>
              当前:{activeStage.label} 
            </span>
            <span style={{
              display: 'inline-flex', alignItems: 'center', minHeight: 22,
              fontSize: 11, fontWeight: 500, padding: '0 8px', borderRadius: 4, lineHeight: 1,
              background: `color-mix(in oklab, var(--status-${taskCompleted ? 'done' : task.status === 'ready' ? 'ready' : task.status}), transparent 85%)`,
              color: `var(--status-${taskCompleted ? 'done' : task.status === 'ready' ? 'ready' : task.status})`,
            }}>
              {STATUS_LABELS[taskCompleted ? 'done' : task.status] || task.status}
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
            上次进程中断后已自动恢复续跑
            {task.recovered_count && task.recovered_count > 1
              ? `（累计 ${task.recovered_count} 次）`
              : ''}，正在从上次未完成阶段继续执行
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
                任务说明
              </div>
              {!editingDescription && (
                <Button
                  variant="ghost"
                  aria-label="编辑任务说明"
                  onClick={openDescriptionEditor}
                  style={{ height: 28, padding: '0 9px', fontSize: 11, gap: 4 }}
                >
                  <span aria-hidden="true">✎</span>
                  编辑
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
                  placeholder="输入任务说明…（支持 Markdown，可直接粘贴图片）"
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
                    取消
                  </Button>
                  <Button
                    variant="primary"
                    disabled={descriptionSaving}
                    loading={descriptionSaving}
                    onClick={() => void saveDescription()}
                  >
                    保存
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
                {task.description ? <MarkdownMessage content={task.description} projectId={projectId} /> : <span style={{ color: 'var(--meta)', fontStyle: 'italic' }}>暂无任务说明</span>}
              </div>
            )}
          </div>

          {/* Progress timeline */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>进度</div>
              {(task?.run_round ?? 1) > 1 && (
                <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 999, color: 'var(--accent)', background: 'color-mix(in oklab, var(--accent), transparent 90%)' }}>
                  第 {task?.run_round} 轮执行
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
                  ? formatDurationBetween(progress?.started_at, progress.ended_at)
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
                    aria-label={`查看${stage.label}阶段的最后一条聊天记录`}
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
                      background: isCompleted || isCurrentActive || isFailed || isSkipped
                        ? stateColor
                        : 'var(--bg)',
                      border: `2px solid ${stateColor}`,
                      position: 'relative', zIndex: 1,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#fff', fontSize: 13, fontWeight: 700,
                      boxShadow: isSelected
                        ? `0 0 0 4px color-mix(in oklab, ${stageColor}, transparent 72%)`
                        : 'none',
                    }}>
                      {isCompleted ? '✓' : isFailed ? '×' : isSkipped ? '–' : ''}
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
                        {STAGE_STATE_LABELS[visualState]}
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
                        第 {stageRound} 轮
                      </span>
                    )}
                    {finishedDuration && (
                      <div style={{
                        fontSize: 11, color: 'var(--meta)', marginTop: 5,
                        textAlign: 'center', lineHeight: 1.5, whiteSpace: 'nowrap',
                      }}>
                        耗时 {finishedDuration}
                      </div>
                    )}
                    {/* Time info for active stage */}
                    {isCurrentActive && (
                      <div style={{ fontSize: 11, color: 'var(--meta)', marginTop: 5, textAlign: 'center', lineHeight: 1.5 }}>
                        <div>开始: {new Date(startedAtMs).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
                        {activeDuration && (
                          <span style={{ color: 'var(--fg-2)', fontWeight: 500 }}>
                            耗时 {activeDuration}
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
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>阶段提示词</div>
              <Button
                variant="ghost"
                onClick={openPromptEditor}
                style={{ height: 28, padding: '0 9px', fontSize: 13, gap: 4 }}
              >
                <span aria-hidden="true">✎</span>
                快速编辑
              </Button>
            </div>
            <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius-sm)', padding: '14px 16px', borderLeft: `3px solid ${currentStageColor}` }}>
              {currentStage.prompt
                ? <MarkdownMessage content={currentStage.prompt} projectId={projectId} />
                : <div style={{ fontSize: 13, color: 'var(--meta)' }}>尚未配置阶段提示词</div>}
            </div>
          </div>

          {/* I/O section — matching card-detail.html layout */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
              阶段输入输出
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: 'var(--meta)' }}>→</span> 输入
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
                          aria-label={`打开输入文件 ${inp.name}`}
                          onClick={() => openArtifact(inp.name)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              openArtifact(inp.name)
                            }
                          }}
                          title={`打开“${inp.name}”对应的文件`}
                          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--surface)', borderRadius: 6, border: '1px solid var(--border-soft)', cursor: 'pointer' }}
                        >
                          <div style={{ width: 6, height: 6, borderRadius: '50%', background: currentStageColor, flexShrink: 0 }} />
                          <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{inp.name}</span>
                          <span style={{ fontSize: 11, color: currentStageColor }}>查看</span>
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
                              aria-label={`打开输出文件 ${out.name}`}
                              onClick={() => openArtifact(out.name, currentStage.key)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault()
                                  openArtifact(out.name, currentStage.key)
                                }
                              }}
                              title={`打开“${out.name}”对应的文件`}
                              style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 18, padding: '4px 8px', cursor: 'pointer', borderRadius: 4 }}
                            >
                              <span style={{ color: 'var(--meta)', fontSize: 11 }}>↳</span>
                              <div style={{ width: 6, height: 6, borderRadius: '50%', background: statusDone ? 'var(--success)' : currentStageColor, flexShrink: 0 }} />
                              <span style={{ fontSize: 13, flex: 1 }}>{out.name}</span>
                              <span style={{ fontSize: 11, color: currentStageColor }}>打开</span>
                              <span style={{ fontSize: 11, color: 'var(--meta)', background: 'var(--surface)', border: '1px solid var(--border-soft)', padding: '0 3px', borderRadius: 2 }}>{out.type}</span>
                              <span style={{
                                fontSize: 11, fontWeight: 500, padding: '1px 5px', borderRadius: 3,
                                background: statusDone ? 'color-mix(in oklab, var(--success), transparent 85%)' : 'var(--surface)',
                                color: statusDone ? 'var(--success)' : 'var(--meta)',
                                border: statusDone ? 'none' : '1px solid var(--border-soft)',
                              }}>
                                {statusDone ? '完成' : '待生成'}
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
                审核结果
              </div>
              <div style={{
                border: '1px solid var(--border-soft)', borderRadius: 8,
                background: 'var(--surface)', padding: 12,
                display: 'flex', flexDirection: 'column', gap: 9,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <strong style={{ fontSize: 13 }}>
                    {selectedReview.mode === 'auto' ? '自动审核' : '人工审核'}
                  </strong>
                  <span className="status-badge" data-s={
                    selectedReview.status === 'passed'
                      ? 'passed'
                      : selectedReview.status === 'rejected'
                        ? 'failed'
                        : 'paused'
                  }>
                    {selectedReview.status === 'passed'
                      ? '已通过'
                      : selectedReview.status === 'rejected'
                        ? '未通过'
                        : selectedReview.status === 'running'
                          ? '审核中'
                          : '等待确认'}
                  </span>
                </div>
                {selectedReview.report && (
                  <>
                    <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                      {selectedReview.report.score !== null && (
                        <strong>{selectedReview.report.score} 分 · </strong>
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
                      placeholder="审核意见（可选）"
                    />
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                      {selectedReview.status === 'pending' ? (
                        <>
                          <Button
                            variant="ghost"
                            disabled={reviewActionPending}
                            onClick={() => void decideReview('reject')}
                          >
                            驳回
                          </Button>
                          <Button
                            variant="primary"
                            disabled={reviewActionPending}
                            loading={reviewActionPending}
                            onClick={() => void decideReview('approve')}
                          >
                            通过并进入下一阶段
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="primary"
                          disabled={reviewActionPending}
                          loading={reviewActionPending}
                          onClick={() => void decideReview('force-approve')}
                        >
                          强制通过
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
              阶段审核配置
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
                    自动审核
                  </label>
                  <span style={{ fontSize: 13, color: 'var(--meta)' }}>重试</span>
                  <Input type="number" min={1} max={5} value={editReviewRetries} onChange={(e) => setEditReviewRetries(Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
                    style={{ width: 40, height: 22, fontSize: 13, padding: '0 6px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--fg)' }} />
                </div>
                <MarkdownEditor
                  value={editReviewPrompt}
                  onChange={setEditReviewPrompt}
                  projectId={projectId}
                  placeholder="审核提示词（留空使用阶段默认）"
                  minHeight={64}
                  maxHeight={160}
                  ariaLabel="审核提示词"
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Button variant="ghost"
                    onClick={async () => {
                      const updated = { ...(task.review_overrides || {}), [currentStage.key]: { auto: editReviewAuto, maxRetries: editReviewRetries, prompt: editReviewPrompt } }
                      await updateTaskDescription(task.id, undefined, projectId!, updated)
                    }}
                    style={{ fontSize: 11, padding: '3px 10px' }}
                  >保存</Button>
                </div>
              </div>
            )}
          </div>

        </div>

        <div
          role="separator"
          tabIndex={0}
          aria-label="调整任务详情左右分栏"
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(splitRatio * 100)}
          className="task-detail-split-handle"
          onPointerDown={beginSplitResize}
          onKeyDown={resizeSplitWithKeyboard}
          onDoubleClick={() => setSplitRatio(DEFAULT_SPLIT_RATIO)}
          title="拖动调整左右分栏，双击恢复 1:2"
        >
          <span aria-hidden="true" />
        </div>

        {/* ── Right panel: Chat ── */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'var(--surface)' }}>
          {/* Chat header */}
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-soft)', background: 'var(--bg)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>对话记录</span>
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
              <div style={{ textAlign: 'center', color: 'var(--meta)', padding: 20, fontSize: 13 }}>加载中...</div>
            )}

            {!historyLoading && historyMessages.length === 0 && events.length === 0 && !content && liveCoordinatorMessages.length === 0 && !running && (
              <div style={{ textAlign: 'center', color: 'var(--meta)', padding: 40, fontSize: 13 }}>
                输入补充说明或追问开始对话
              </div>
            )}

            {/* Historical messages in persistent task sequence order */}
            {(() => {
              const orderedMessages = [...historyMessages]
                .filter(isVisibleHistoryMessage)
                .map((message: any) => mergeHistoryMessageWithLive(
                  message,
                  liveMessages[String(message.id)],
                ))
                .sort((left: any, right: any) => (
                  (left.sequence ?? Number.MAX_SAFE_INTEGER)
                  - (right.sequence ?? Number.MAX_SAFE_INTEGER)
                ))
              return orderedMessages.map((message: any) => {
                const stageKey = message.context_step_key || message.step_key || 'unknown'
                const msgs = [message]
                const stageInfo = stages.find((s: any) => s.key === stageKey)
                const stageLabel = message.channel === 'coordinator'
                  ? '协调 Agent'
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
                        ? '我'
                        : isSystem
                          ? '系统'
                          : isCoordinator
                            ? '协调 Agent'
                            : stageLabel
                      const initials = isUser || isSystem
                          ? sender.slice(0, 2)
                          : isCoordinator
                            ? '协'
                          : stageAvatarText(stageLabel)
                      const senderColor = isUser
                        ? 'var(--accent)'
                        : isSystem
                          ? 'var(--warn)'
                          : isReview
                            ? (stageInfo?.color || 'var(--warn)')
                          : isCoordinator
                            ? '#7c3aed'
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
                          badge={isReview ? <span title="Review" aria-label="Review 消息">R</span> : undefined}
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
                              {isCoordinator
                                ? formatConversationDateTime(msg.started_at || msg.created_at)
                                : formatExecutionOffset(msg.started_at || msg.created_at, executionOrigin)}
                              <span
                                title={isCoordinator
                                  ? '发给协调 Agent，不进入阶段执行上下文'
                                  : isLiveInsert
                                    ? '执行中插入的消息，引擎对此二次处理'
                                    : '阶段初始输入，进入阶段执行上下文'}
                                style={{
                                  padding: '1px 6px', borderRadius: 999, fontSize: 11,
                                  border: isLiveInsert ? 'none' : '1px solid var(--border-soft)',
                                  background: isCoordinator
                                    ? 'rgba(124,58,237,0.08)'
                                    : isLiveInsert
                                      ? 'var(--accent)'
                                      : 'rgba(0,113,227,0.08)',
                                  color: isCoordinator
                                    ? '#7c3aed'
                                    : isLiveInsert ? 'var(--accent-fg)' : 'var(--accent)',
                                }}
                              >
                                {isCoordinator ? '协调' : isLiveInsert ? '插入' : '阶段'}
                              </span>
                            </>
                          ) : (
                            <MessageMetaBar
                              createdAt={msg.created_at}
                              startedAt={msg.started_at}
                              endedAt={msg.ended_at}
                              running={msg.run_status === 'running'}
                              events={processEvents}
                              prompt={msg.prompt}
                              sessionId={isCoordinator ? null : sessionIdForStep(stageKey)}
                              onViewPrompt={setViewingPrompt}
                              origin={isCoordinator ? undefined : executionOrigin}
                              actions={!isUser && !isCoordinator && msg.run_status === 'running'
                                ? <StageStopButton stepKey={stageKey} onStop={handleStopStage} />
                                : undefined}
                            />
                          )}
                          showLoading={!isUser && !isCoordinator && msg.run_status === 'running' && !msg.content}
                          loading={!isUser && msg.run_status === 'running'
                            ? (
                              <div className="engine-loading-message" role="status" aria-live="polite">
                                <span>{liveExecutionStatus(processEvents)}</span>
                                <span className="engine-loading-dots" aria-hidden="true">
                                  <i />
                                  <i />
                                  <i />
                                </span>
                              </div>
                            )
                            : undefined}
                          footer={!isUser && !isSystem && msg.content
                            ? (
                              <MessageResponseFooter
                                content={String(msg.content)}
                                usage={msg.usage || usageFromEvents(processEvents)}
                                engine={msg.engine}
                                model={msg.model}
                                executionModel={executionStageModel}
                                running={msg.run_status === 'running'}
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
                sender="协调 Agent"
                initials="协"
                color="#7c3aed"
                content={message.content || ''}
                streaming={message.status === 'running'}
                variant="bg"
                header={
                  <MessageMetaBar
                    createdAt={message.created_at}
                    running={message.status === 'running'}
                    events={message.events}
                    prompt={message.prompt || livePromptOverrides[message.id]}
                    sessionId={sessionIdForStep(message.step_key)}
                    onViewPrompt={setViewingPrompt}
                  />
                }
                showLoading={!message.content && message.status === 'running'}
                loading={
                  <div className="engine-loading-message" role="status">协调 Agent 思考中…</div>
                }
                footer={message.content ? (
                  <MessageResponseFooter
                    content={message.content}
                    usage={usageFromEvents(message.events)}
                    engine={message.engine}
                    model={message.model}
                    executionModel={executionStageModel}
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

            {liveExecutionMessages.map((message) => {
              const stage = stages.find((item) => item.key === message.step_key)
              const stageLabel = stage?.label || message.step_key || '执行阶段'
              return (
                <ChatMessageBubble
                  key={message.id}
                  role="assistant"
                  sender={stageLabel}
                  initials={stageAvatarText(stageLabel)}
                  color={stage?.color || activeStageColor}
                  content={message.content || ''}
                  streaming={message.status === 'running'}
                  variant="bg"
                  header={
                    <MessageMetaBar
                      createdAt={message.created_at}
                      running={message.status === 'running'}
                      events={message.events}
                      prompt={message.prompt || livePromptOverrides[message.id]}
                      onViewPrompt={setViewingPrompt}
                      origin={executionOrigin}
                      actions={message.status === 'running' && message.step_key
                        ? <StageStopButton stepKey={message.step_key} onStop={handleStopStage} />
                        : undefined}
                    />
                  }
                  showLoading={!message.content && message.status === 'running'}
                  loading={
                    <div className="engine-loading-message" role="status" aria-live="polite">
                      <span>{liveExecutionStatus(message.events)}</span>
                      <span className="engine-loading-dots" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                    </div>
                  }
                  footer={message.content ? (
                    <MessageResponseFooter
                      content={message.content}
                      usage={usageFromEvents(message.events)}
                      engine={message.engine}
                      model={message.model}
                      executionModel={executionStageModel}
                      running={message.status === 'running'}
                    />
                  ) : undefined}
                />
              )
            })}

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
                initials={stageAvatarText(activeStage.label)}
                color={activeStageColor}
                content={content}
                streaming={running}
                variant="bg"
                header={<ProcessTrace events={events} running={running} />}
                showLoading={running && !content && !hasProcessEvents(events)}
                loading={
                  <div className="engine-loading-message" role="status" aria-live="polite">
                    <span>处理中</span>
                    <span className="engine-loading-dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                }
                footer={content ? (
                  <MessageResponseFooter
                    content={content}
                    usage={usageFromEvents(events)}
                    engine={task.engine}
                    model={task.model}
                    executionModel={executionStageModel}
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
              aria-label="查看新消息"
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
              有新消息 <span aria-hidden="true">↓</span>
            </button>
          )}
          </div>

          {/* Chat input */}
          <div style={{ position: 'relative', padding: '14px 20px', borderTop: '1px solid var(--border-soft)', background: 'var(--bg)', display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0 }}>
            {chatTargetStage && stageInserts.length > 0 && (
              <div role="region" aria-label="插入消息" style={{
                position: 'absolute', bottom: '100%', left: 20, right: 20,
                marginBottom: 6, zIndex: 30,
                borderRadius: 8, border: '1px solid var(--border-soft)',
                background: 'var(--bg)',
                boxShadow: '0 2px 12px rgba(0,0,0,0.12)',
                padding: '6px 10px',
                display: 'flex', flexDirection: 'column', gap: 4,
              }}>
                <div
                  title={`发送后实时注入「${activeStage.label}」阶段执行`}
                  style={{ fontSize: 11, fontWeight: 600, color: 'var(--meta)', display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  插入消息
                  <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--muted)' }}>
                    {stageInserts.length} 条
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
                            title="保存修改"
                            style={{
                              padding: '2px 8px', borderRadius: 6, fontSize: 11,
                              border: 'none', background: 'var(--accent)', color: 'var(--accent-fg)',
                              cursor: 'pointer',
                            }}
                          >
                            保存
                          </button>
                          <button
                            type="button"
                            onClick={handleStageInsertEditCancel}
                            title="取消编辑"
                            style={{
                              padding: '2px 8px', borderRadius: 6, fontSize: 11,
                              border: '1px solid var(--border)',
                              background: 'transparent', color: 'var(--meta)',
                              cursor: 'pointer',
                            }}
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => handleStageInsertGuidance(insert)}
                            title="同时注入执行，并保存为阶段引导（后续重跑也会带上）"
                            style={{
                              padding: '2px 6px', fontSize: 11,
                              border: 'none', background: 'transparent',
                              color: 'var(--meta)', cursor: 'pointer',
                            }}
                          >
                            引导
                          </button>
                          <button
                            type="button"
                            onClick={() => handleStageInsertRemove(insert.id)}
                            title="删除这条插入消息"
                            style={{
                              padding: '4px', border: 'none', background: 'transparent',
                              color: 'var(--muted)', cursor: 'pointer',
                              display: 'flex', alignItems: 'center', borderRadius: 4,
                            }}
                          >
                            <Icon name="trash" size={12} strokeWidth={2} />
                          </button>
                          <button
                            type="button"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => setOpenInsertMenuId(
                              openInsertMenuId === insert.id ? null : insert.id
                            )}
                            title="更多操作"
                            style={{
                              padding: '4px', border: 'none', background: 'transparent',
                              color: 'var(--muted)', cursor: 'pointer',
                              display: 'flex', alignItems: 'center', borderRadius: 4,
                            }}
                          >
                            <Icon name="ellipsis" size={12} fill />
                          </button>
                          {openInsertMenuId === insert.id && (
                            <div
                              onPointerDown={(event) => event.stopPropagation()}
                              style={{
                                position: 'absolute', right: 4, top: 'calc(100% + 2px)',
                                zIndex: 40, minWidth: 104, padding: 4, borderRadius: 8,
                                background: 'var(--bg)',
                                border: '1px solid var(--border-soft)',
                                boxShadow: '0 4px 16px rgba(0,0,0,0.14)',
                                display: 'flex', flexDirection: 'column',
                              }}
                            >
                              <button
                                type="button"
                                onClick={() => handleStageInsertSend(insert)}
                                title="立即注入当前阶段执行（不保存为引导）"
                                style={{
                                  padding: '5px 8px', fontSize: 11, textAlign: 'left',
                                  border: 'none', background: 'transparent',
                                  color: 'var(--fg)', cursor: 'pointer', borderRadius: 5,
                                }}
                              >
                                发送
                              </button>
                              <button
                                type="button"
                                onClick={() => handleStageInsertEditStart(insert)}
                                title="编辑这条插入消息"
                                style={{
                                  padding: '5px 8px', fontSize: 11, textAlign: 'left',
                                  border: 'none', background: 'transparent',
                                  color: 'var(--fg)', cursor: 'pointer', borderRadius: 5,
                                }}
                              >
                                编辑
                              </button>
                              <button
                                type="button"
                                onClick={() => handleStageInsertRemove(insert.id)}
                                title="删除这条插入消息"
                                style={{
                                  padding: '5px 8px', fontSize: 11, textAlign: 'left',
                                  border: 'none', background: 'transparent',
                                  color: 'var(--danger)', cursor: 'pointer', borderRadius: 5,
                                }}
                              >
                                删除
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ))}
                {stageInserts.length > 1 && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 2 }}>
                  <button
                    type="button"
                    onClick={handleSendAllInserts}
                    title="把全部插入消息按顺序合并，一次实时注入阶段执行"
                    style={{
                      padding: '2px 6px', fontSize: 11,
                      border: 'none', background: 'transparent',
                      color: 'var(--accent)', cursor: 'pointer',
                    }}
                  >
                    全部发送（{stageInserts.length}）
                  </button>
                </div>
                )}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 8, background: 'var(--bg-soft, rgba(128,128,128,0.08))', border: '1px solid var(--border-soft)' }}>
                <button
                  type="button"
                  onClick={() => setChatTarget('coordinator')}
                  aria-pressed={!chatTargetStage}
                  title="发送给协调 Agent，不进入阶段执行上下文"
                  style={{
                    padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                    border: 'none', cursor: 'pointer',
                    background: chatTargetStage ? 'transparent' : 'var(--accent)',
                    color: chatTargetStage ? 'var(--meta)' : 'var(--accent-fg)',
                  }}
                >
                  协调 Agent
                </button>
                <button
                  type="button"
                  onClick={() => setChatTarget('stage')}
                  disabled={!activeStageRunning}
                  aria-pressed={chatTargetStage}
                  title={activeStageRunning
                    ? '发送给当前正在执行的阶段 Agent，实时注入执行'
                    : '当前阶段未在运行，无法发送阶段消息'}
                  style={{
                    padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                    border: 'none', cursor: activeStageRunning ? 'pointer' : 'not-allowed',
                    background: chatTargetStage ? 'var(--accent)' : 'transparent',
                    color: chatTargetStage ? 'var(--accent-fg)' : 'var(--meta)',
                    opacity: activeStageRunning ? 1 : 0.5,
                  }}
                >
                  阶段 Agent
                </button>
              </div>
              {chatTargetStage && activeStageRunning && (
                <span style={{ fontSize: 11, color: 'var(--meta)' }}>
                  发送后进入「插入消息」面板，确认后再实时注入「{activeStage.label}」阶段
                </span>
              )}
              {chatTargetStage && !activeStageRunning && (
                <span style={{ fontSize: 11, color: 'var(--warn)' }}>
                  当前阶段未在运行，仅可发送给协调 Agent
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
              imageAttach={projectId ? {
                projectId,
                prefix: taskId?.slice(0, 8) ?? '',
                onError: (message) => setChatError(message),
              } : undefined}
              stopTitle={chatTargetStage ? '停止当前阶段执行' : '停止生成'}
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
                hint: coordinatorConfig ? '从下一条消息生效' : '',
                engineTitle: '只影响后续协调消息，不修改工作流阶段引擎',
                onEngineChange: (engineId) => void handleCoordinatorEngineChange(engineId),
                onModelChange: (model) => void handleCoordinatorModelChange(model),
                onFastModelChange: (fastModel) => void handleCoordinatorFastModelChange(fastModel),
                onVisionModelChange: (visionModel) => void handleCoordinatorVisionModelChange(visionModel),
                onReset: () => void handleCoordinatorEngineChange(''),
              }}
              disabled={chatTargetStage ? false : coordinatorRunning}
              running={!chatTargetStage && coordinatorRunning}
              onStop={chatTargetStage ? undefined : handleStopCoordinator}
              placeholder={chatTargetStage
                ? `输入消息，回车后进入「插入消息」面板，确认后注入「${activeStage.label}」阶段...`
                : coordinatorRunning
                  ? '协调 Agent 处理中...'
                  : '输入问题、补充说明或操作请求...'}
              title={chatTargetStage
                ? '把输入加入上方「插入消息」面板'
                : coordinatorRunning ? '停止协调 Agent 处理' : '发送给协调 Agent'}
            />
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
      <div style={{ padding: '14px 24px', borderTop: '1px solid var(--border-soft)', display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0 }}>
        <Button variant="ghost" onClick={onClose}>关闭</Button>
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
          aria-label="完整提示词"
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
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 12 }}>
              <strong style={{ flex: 1, fontSize: 13 }}>完整提示词</strong>
              <Button variant="icon" aria-label="关闭提示词" onClick={() => setViewingPrompt(null)}>✕</Button>
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
          aria-label={`快速编辑${currentStage.label}阶段提示词`}
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
            <div style={{ padding: '15px 18px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: currentStageColor }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>快速编辑阶段提示词</div>
                <div style={{ marginTop: 2, fontSize: 11, color: 'var(--meta)' }}>{currentStage.label} · {currentStage.key}</div>
              </div>
              <Button variant="icon" disabled={promptSaving} onClick={() => setShowPromptEditor(false)}>✕</Button>
            </div>
            <div style={{ padding: 18 }}>
              <MarkdownEditor
                value={promptDraft}
                onChange={setPromptDraft}
                projectId={projectId}
                placeholder="描述该阶段的目标、输入、执行要求和输出规范……"
                minHeight={260}
                maxHeight="55vh"
                autoFocus
                ariaLabel={`${currentStage.label}阶段提示词`}
              />
              {promptSaveError && (
                <div role="alert" style={{ marginTop: 8, color: 'var(--danger)', fontSize: 13 }}>
                  {promptSaveError}
                </div>
              )}
            </div>
            <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border-soft)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button variant="ghost" disabled={promptSaving} onClick={() => setShowPromptEditor(false)}>取消</Button>
              <Button variant="primary" disabled={promptSaving} loading={promptSaving} onClick={saveStagePrompt}>
                保存提示词
              </Button>
            </div>
          </div>
        </div>
      )}

      {previewArtifact && (
        <div
          role="dialog"
          aria-label={`产物预览 ${previewArtifact.logical_name || previewArtifact.name}`}
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
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {previewArtifact.logical_name || previewArtifact.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--meta)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {previewArtifact.path}
                </div>
              </div>
              <Button variant="ghost" onClick={openArtifactDirectory}>
                打开所在目录
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
