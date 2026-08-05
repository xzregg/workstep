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
  engineApi,
  projectApi,
  taskApi,
  type ActionProposal,
  type CoordinatorConfig,
  type EngineModel,
  type ReviewRun,
  type TaskArtifact,
  type TaskStepState,
} from '../api/client'
import ArtifactPreview from '../components/ArtifactPreview'
import MarkdownEditor from '../components/MarkdownEditor'
import MarkdownMessage from '../components/MarkdownMessage'
import ProcessTrace from '../components/ProcessTrace'
import EngineSelect from '../components/EngineSelect'
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
  formatConversationDateTime,
  formatDurationBetween,
  toMilliseconds,
} from '../utils/datetime'
import { engineLabel } from '../engineMeta'

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

type MessageUsage = Record<string, unknown> | null | undefined

function usageFromEvents(events: any[]): MessageUsage {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'usage' && event.data && typeof event.data === 'object') {
      return event.data as Record<string, unknown>
    }
  }
  return null
}

function usageValue(usage: MessageUsage, ...keys: string[]) {
  for (const key of keys) {
    const value = usage?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return 0
}

function formatTokenUsage(usage?: MessageUsage) {
  if (!usage || Object.keys(usage).length === 0) {
    return 'Token：暂无数据'
  }
  if (usage.usage_kind === 'context_window') {
    const used = usageValue(usage, 'used')
    const size = usageValue(usage, 'size')
    const number = new Intl.NumberFormat('zh-CN')
    const occupancy = size > 0 ? ` · 占用 ${Math.min(100, (used / size) * 100).toFixed(1)}%` : ''
    return `Token · 上下文 ${number.format(used)} / ${number.format(size)}${occupancy}`
  }
  const input = usageValue(usage, 'input_tokens', 'prompt_tokens')
  const output = usageValue(usage, 'output_tokens', 'completion_tokens')
  const cacheRead = usageValue(
    usage,
    'cache_read_input_tokens',
    'cached_tokens',
  )
  const cacheWrite = usageValue(usage, 'cache_creation_input_tokens')
  const reportedTotal = usageValue(usage, 'total_tokens')
  const total = reportedTotal || input + output
  const number = new Intl.NumberFormat('zh-CN')
  const parts = input > 0 || output > 0
    ? [`输入 ${number.format(input)}`, `输出 ${number.format(output)}`]
    : []
  if (cacheRead > 0) parts.push(`缓存读取 ${number.format(cacheRead)}`)
  if (cacheWrite > 0) parts.push(`缓存写入 ${number.format(cacheWrite)}`)
  const cacheInput = 'prompt_tokens' in usage
    ? input
    : input + cacheRead + cacheWrite
  if (cacheInput > 0) {
    const cacheHitRate = Math.min(100, (cacheRead / cacheInput) * 100)
    parts.push(`缓存命中 ${cacheHitRate.toFixed(1)}%`)
  }
  parts.push(`总计 ${number.format(total)}`)
  return `Token · ${parts.join(' · ')}`
}

async function copyMessageText(content: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = content
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('Copy failed')
}

function MessageResponseFooter({
  content,
  usage,
  engine,
  running = false,
}: {
  content: string
  usage?: MessageUsage
  engine?: string | null
  running?: boolean
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const usageSummary = running ? '' : formatTokenUsage(usage)

  const copy = async () => {
    try {
      await copyMessageText(content)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <div style={{
      minHeight: 24, display: 'flex', alignItems: 'center', gap: 8,
      color: 'var(--meta)', fontSize: 10,
    }}>
      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
        {usageSummary}
        {!running && engine ? ` · ${engineLabel(engine)}` : ''}
      </span>
      <button
        type="button"
        className="btn-ghost"
        aria-label={copyState === 'copied' ? '消息已复制' : '复制 LLM 消息'}
        title={running
          ? '消息生成完成后可复制'
          : copyState === 'copied'
            ? '已复制'
            : copyState === 'failed'
              ? '复制失败'
              : '复制消息'}
        disabled={running || !content}
        onClick={() => void copy()}
        style={{
          width: 24, height: 24, minWidth: 24, padding: 0,
          justifyContent: 'center',
          color: copyState === 'failed'
            ? 'var(--danger)'
            : copyState === 'copied'
              ? 'var(--success)'
              : 'var(--muted)',
          fontSize: 10,
        }}
      >
        {copyState === 'copied' ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
            <path d="m5 12 4 4L19 6" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
    </div>
  )
}

function MessageMetaBar({
  createdAt,
  startedAt,
  endedAt,
  running = false,
  events,
  prompt,
  onViewPrompt,
}: {
  createdAt?: string | number | null
  startedAt?: string | number | null
  endedAt?: string | number | null
  running?: boolean
  events?: any[]
  prompt?: string | null
  onViewPrompt: (prompt: string) => void
}) {
  const eventStartedAt = (events || []).reduce<number | null>((earliest, event) => {
    const timestamp = toMilliseconds(event?.created_at ?? event?.timestamp)
    if (timestamp === null) return earliest
    return earliest === null ? timestamp : Math.min(earliest, timestamp)
  }, null)
  const displayStartedAt = startedAt || createdAt || eventStartedAt

  return (
    <div style={{
      width: '100%', minHeight: 30,
      display: 'flex', alignItems: 'flex-start', gap: 12,
      paddingBottom: 6, borderBottom: '1px solid var(--border-soft)',
      color: 'var(--meta)', fontSize: 11, flexWrap: 'wrap',
    }}>
      <span style={{ width: 112, minHeight: 24, display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>{formatConversationDateTime(displayStartedAt)}</span>
      <ProcessTrace
        events={events || []}
        running={running}
        startedAt={displayStartedAt}
        endedAt={endedAt}
        compact
      />
      {prompt && (
        <button
          type="button"
          className="btn-ghost"
          onClick={() => onViewPrompt(prompt)}
          style={{ marginLeft: 'auto', padding: 0, minHeight: 24, color: 'var(--accent)', fontSize: 11, alignItems: 'center' }}
        >
          查看提示词
        </button>
      )}
    </div>
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
      <div style={{ fontSize: 12, fontWeight: 700 }}>协调动作 · {current.type}</div>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        {current.impact?.summary || `目标阶段：${current.target_step_key || '无'}`}
      </div>
      <div style={{ fontSize: 11, color: current.status === 'failed' ? 'var(--danger)' : 'var(--meta)' }}>
        状态：{current.status}{current.error ? ` · ${current.error}` : ''}
      </div>
      {error && <div style={{ fontSize: 11, color: 'var(--danger)' }}>{error}</div>}
      {(current.status === 'pending' || retryable) && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-primary" disabled={!canAct} onClick={() => void confirm()}>{pending ? '处理中...' : retryable ? '重试' : '确认'}</button>
          {current.status === 'pending' && (
            <button className="btn-ghost" disabled={!canAct} onClick={() => void cancel()}>取消</button>
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
  | 'failed'
  | 'skipped'
  | 'pending'

interface StageData {
  key: string
  label: string
  color: string
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
  const [activeCoordinatorMessageId, setActiveCoordinatorMessageId] = useState<string | null>(null)
  const [coordinatorConfig, setCoordinatorConfig] = useState<CoordinatorConfig | null>(null)
  const [coordinatorConfigSaving, setCoordinatorConfigSaving] = useState(false)
  const [coordinatorConfigError, setCoordinatorConfigError] = useState('')
  const [coordinatorConfigNotice, setCoordinatorConfigNotice] = useState('')
  const [coordinatorModels, setCoordinatorModels] = useState<EngineModel[]>([])
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
    const engineId = coordinatorConfig?.resolved.engine
    if (!engineId) {
      setCoordinatorModels([])
      return
    }
    engineApi.models(engineId)
      .then((result) => setCoordinatorModels(result.models || []))
      .catch(() => setCoordinatorModels([]))
  }, [coordinatorConfig?.resolved.engine])

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
    if (!activeMessage || !['succeeded', 'failed'].includes(activeMessage.status)) return
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
    if (steps?.nodes?.length) return steps.nodes.map((n: any) => ({ key: n.type || n.key, label: n.title || n.label, color: n.color || '#888', prompt: n.prompt || '', inputs: (n.inputs || []).map((i: any) => ({ name: i.name, type: i.type, outputs: i.outputs || [] })), outputs: (n.outputs || []).map((o: any) => ({ name: o.name, type: o.type })) }))
    if (steps?.steps?.length) return steps.steps.map((s: any) => ({ key: s.key || s.id, label: s.label || s.name, color: s.color || '#888', prompt: s.prompt || '', inputs: (s.inputs || []).map((i: any) => ({ name: i.name || i, type: i.type || 'any', outputs: i.outputs || [] })), outputs: (s.outputs || []).map((o: any) => ({ name: o.name || o, type: o.type || 'any' })) }))
    return [{ key: 'do', label: '执行', color: '#0071e3', prompt: '', inputs: [], outputs: [] }]
  }, [activeProject?.steps])

  const stageProgress = useMemo<StageProgress[]>(() => {
    const stepByKey = new Map(
      (task?.steps || []).map((step) => [step.step_key, step]),
    )
    const rawStatuses: TaskStepState['status'][] = stages.map(
      (stage: any) => stepByKey.get(stage.key)?.status || 'pending',
    )
    let activeIndex = rawStatuses.findIndex((status) =>
      ['running', 'reviewing', 'awaiting_review', 'retrying'].includes(status)
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
      else if (status === 'running') visualState = 'current'
      else if (status === 'failed' || status === 'rejected') visualState = 'failed'
      else if (status === 'skipped') visualState = 'skipped'
      else if (index === activeIndex) visualState = 'current'
      return { ...step, visualState }
    })
  }, [stages, task?.steps])

  const activeStageIndex = useMemo(() => {
    const current = stageProgress.findIndex((progress: StageProgress) =>
      ['current', 'reviewing', 'awaiting_review', 'retrying'].includes(
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
      'reviewing', 'awaiting_review', 'retrying',
    ].includes(progress.visualState)
  )

  useEffect(() => {
    if (!shouldTickDuration) return
    setDurationNowMs(Date.now())
    const timer = window.setInterval(() => setDurationNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [shouldTickDuration])

  const handleRun = async () => {
    if (!taskId || !prompt.trim() || !projectId || coordinatorRunning) return
    const submittedPrompt = prompt.trim()
    const optimisticId = `pending-${crypto.randomUUID()}`
    const optimisticMessage = createOptimisticUserMessage(
      optimisticId,
      submittedPrompt,
      activeStage.key,
      new Date().toISOString(),
    )
    shouldFollowMessagesRef.current = true
    setHasUnreadMessages(false)
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
    } catch {
      setHistoryMessages((current) => current.filter(
        (message) => message.id !== optimisticId
      ))
      setPrompt(submittedPrompt)
      setCoordinatorRunning(false)
    }
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
        <button className="btn-ghost" style={{ marginTop: 12 }} onClick={onClose}>← 返回</button>
      </div>
    )
  }

  const currentStageColor = currentStage.color || 'var(--accent)'
  const activeStageColor = activeStage.color || 'var(--accent)'
  const selectedReview = reviews.find((review) => review.step_key === currentStage.key)
  const activeReview = reviews.find((review) => review.step_key === activeStage.key)
  const activeStepStatus = stageProgress[activeStageIndex]?.status || 'pending'
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
        <button className="btn-icon" onClick={onClose}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.4 }}>{task.title}</span>
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
                fontFamily: 'var(--font-mono)', fontSize: 10,
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

            <span style={{ display: 'inline-flex', alignItems: 'center', minHeight: 22, fontSize: 12, lineHeight: 1, color: 'var(--meta)' }}>{time}</span>
          </div>
        </div>
      </div>

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
                fontSize: 13, fontWeight: 600, color: 'var(--muted)',
                textTransform: 'uppercase', letterSpacing: '0.5px',
              }}>
                任务说明
              </div>
              {!editingDescription && (
                <button
                  type="button"
                  className="btn-ghost"
                  aria-label="编辑任务说明"
                  onClick={openDescriptionEditor}
                  style={{ height: 28, padding: '0 9px', fontSize: 11, gap: 4 }}
                >
                  <span aria-hidden="true">✎</span>
                  编辑
                </button>
              )}
            </div>
            {editingDescription ? (
              <div>
                <MarkdownEditor
                  value={descriptionDraft}
                  onChange={setDescriptionDraft}
                  projectId={projectId}
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
                  <button
                    className="btn-ghost"
                    disabled={descriptionSaving}
                    onClick={() => setEditingDescription(false)}
                  >
                    取消
                  </button>
                  <button
                    className="btn-primary"
                    disabled={descriptionSaving}
                    onClick={() => void saveDescription()}
                  >
                    {descriptionSaving ? '保存中…' : '保存'}
                  </button>
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
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--fg-2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 14 }}>进度</div>
            <div style={{ display: 'flex', gap: 0, position: 'relative' }}>
              {stages.map((stage: any, i: number) => {
                const progress = stageProgress[i]
                const visualState = progress?.visualState || 'pending'
                const isCompleted = visualState === 'completed'
                const isCurrentActive = [
                  'current', 'reviewing', 'awaiting_review', 'retrying',
                ].includes(visualState)
                const isFailed = visualState === 'failed'
                const isSkipped = visualState === 'skipped'
                const isSelected = i === selectedStage
                const stageColor = stage.color || 'var(--accent)'
                const stageLabelColor = isSkipped ? 'var(--meta)' : stageColor
                const finishedDuration = progress?.ended_at
                  ? formatDurationBetween(progress?.started_at, progress.ended_at)
                  : null
                const startedAtMs = toMilliseconds(progress?.started_at)
                  ?? toMilliseconds(task.created_at)
                  ?? Date.now()
                const updatedAtMs = toMilliseconds(task.updated_at) ?? Date.now()
                const isDurationLive = task.status === 'running' || [
                  'reviewing', 'awaiting_review', 'retrying',
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
                      : visualState === 'retrying'
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
                      left: i === 0 ? '50%' : 0, right: i === stages.length - 1 ? '50%' : 0,
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
                      color: '#fff', fontSize: 12, fontWeight: 700,
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
                        fontSize: 10, marginTop: 4, padding: '2px 6px',
                        borderRadius: 999,
                        color: stateColor,
                        background: `color-mix(in oklab, ${stateColor}, transparent 88%)`,
                        fontWeight: 600,
                      }}>
                        {STAGE_STATE_LABELS[visualState]}
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
              <div style={{ fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>阶段提示词</div>
              <button
                className="btn-ghost"
                onClick={openPromptEditor}
                style={{ height: 28, padding: '0 9px', fontSize: 12, gap: 4 }}
              >
                <span aria-hidden="true">✎</span>
                快速编辑
              </button>
            </div>
            <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius-sm)', padding: '14px 16px', borderLeft: `3px solid ${currentStageColor}` }}>
              {currentStage.prompt
                ? <MarkdownMessage content={currentStage.prompt} projectId={projectId} />
                : <div style={{ fontSize: 13, color: 'var(--meta)' }}>尚未配置阶段提示词</div>}
            </div>
          </div>

          {/* I/O section — matching card-detail.html layout */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
              阶段输入输出
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
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
                              <span style={{ fontSize: 12, flex: 1 }}>{out.name}</span>
                              <span style={{ fontSize: 10, color: currentStageColor }}>打开</span>
                              <span style={{ fontSize: 10, color: 'var(--meta)', background: 'var(--surface)', border: '1px solid var(--border-soft)', padding: '0 3px', borderRadius: 2 }}>{out.type}</span>
                              <span style={{
                                fontSize: 9, fontWeight: 500, padding: '1px 5px', borderRadius: 3,
                                background: statusDone ? 'color-mix(in oklab, var(--success), transparent 85%)' : 'var(--surface)',
                                color: statusDone ? 'var(--success)' : 'var(--meta)',
                                border: statusDone ? 'none' : '1px solid var(--border-soft)',
                              }}>
                                {statusDone ? '完成' : '待生成'}
                              </span>
                              {nextInput && (
                                <span style={{ fontSize: 10, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 2 }}>
                                  <span style={{ color: 'var(--meta)', fontSize: 9 }}>→</span> {nextStage?.label}: {nextInput.name}
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
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
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
                    <div style={{ fontSize: 12, lineHeight: 1.6 }}>
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
                    <textarea
                      rows={2}
                      value={reviewComment}
                      onChange={(event) => setReviewComment(event.target.value)}
                      placeholder="审核意见（可选）"
                    />
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                      {selectedReview.status === 'pending' ? (
                        <>
                          <button
                            className="btn-ghost"
                            disabled={reviewActionPending}
                            onClick={() => void decideReview('reject')}
                          >
                            驳回
                          </button>
                          <button
                            className="btn-primary"
                            disabled={reviewActionPending}
                            onClick={() => void decideReview('approve')}
                          >
                            通过并进入下一阶段
                          </button>
                        </>
                      ) : (
                        <button
                          className="btn-primary"
                          disabled={reviewActionPending}
                          onClick={() => void decideReview('force-approve')}
                        >
                          强制通过
                        </button>
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
                color: 'var(--muted)', fontSize: 13, fontWeight: 600,
                textTransform: 'uppercase', letterSpacing: '0.5px',
                padding: '0', fontFamily: 'var(--font-body)',
              }}
            >
              <span style={{
                transform: showReviewDrawer ? 'rotate(90deg)' : 'none',
                transition: 'transform 150ms', display: 'inline-block', fontSize: 10,
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
                  <span style={{ fontSize: 12, color: 'var(--meta)' }}>重试</span>
                  <input type="number" min={1} max={5} value={editReviewRetries} onChange={(e) => setEditReviewRetries(Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
                    style={{ width: 40, height: 22, fontSize: 12, padding: '0 6px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--fg)' }} />
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
                  <button className="btn-ghost"
                    onClick={async () => {
                      const updated = { ...(task.review_overrides || {}), [currentStage.key]: { auto: editReviewAuto, maxRetries: editReviewRetries, prompt: editReviewPrompt } }
                      await updateTaskDescription(task.id, undefined, projectId!, updated)
                    }}
                    style={{ fontSize: 11, padding: '3px 10px' }}
                  >保存</button>
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
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>对话记录</span>
            <span style={{ fontSize: 11, fontWeight: 600, color: currentStageColor, background: `color-mix(in oklab, ${currentStageColor}, transparent 88%)`, padding: '2px 8px', borderRadius: 4 }}>
              {currentStage.label}
            </span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--meta)' }}>协调引擎</span>
            <EngineSelect
              engines={coordinatorConfig?.available_engines || []}
              value={coordinatorConfig?.configured.engine || ''}
              disabled={!coordinatorConfig || coordinatorConfigSaving || coordinatorRunning}
              onChange={(engineId) => void handleCoordinatorEngineChange(engineId)}
              requireCoordinator
              defaultOption={{
                value: '',
                label: `默认（${engineLabel(coordinatorConfig?.resolved.engine || task.coordinator_engine || task.engine || 'claude')}）`,
              }}
              ariaLabel="协调引擎"
              title="只影响后续协调消息，不修改工作流阶段引擎"
              style={{ fontSize: 11, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)', color: 'var(--fg)', padding: '4px 7px' }}
            />
            <select
              value={coordinatorConfig?.configured.model || ''}
              disabled={!coordinatorConfig || coordinatorConfigSaving || coordinatorRunning || coordinatorModels.length === 0}
              onChange={(event) => void handleCoordinatorModelChange(event.target.value)}
              title="推理模型：负责理解、决策与回复；从下一条消息生效"
              style={{ maxWidth: 150, fontSize: 11, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)', color: 'var(--fg)', padding: '4px 7px' }}
            >
              <option value="">推理模型（默认）</option>
              {coordinatorModels.map((model) => (
                <option key={model.id} value={model.id}>{model.label || model.id}</option>
              ))}
            </select>
            <select
              value={coordinatorConfig?.configured.fast_model || ''}
              disabled={!coordinatorConfig || coordinatorConfigSaving || coordinatorRunning || coordinatorModels.length === 0}
              onChange={(event) => void handleCoordinatorFastModelChange(event.target.value)}
              title="快速模型：负责读取产物和修复结构化输出；从下一条消息生效"
              style={{ maxWidth: 150, fontSize: 11, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)', color: 'var(--fg)', padding: '4px 7px' }}
            >
              <option value="">快速模型（跟随推理）</option>
              {coordinatorModels.map((model) => (
                <option key={model.id} value={model.id}>{model.label || model.id}</option>
              ))}
            </select>
          </div>
          {coordinatorConfigError && (
            <div style={{ padding: '6px 20px', color: 'var(--danger)', fontSize: 11, background: 'var(--bg)' }}>
              {coordinatorConfigError}
            </div>
          )}
          {coordinatorConfigNotice && !coordinatorConfigError && (
            <div style={{ padding: '6px 20px', color: 'var(--success)', fontSize: 11, background: 'var(--bg)' }}>
              {coordinatorConfigNotice}
            </div>
          )}

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
                        <div
                          key={i}
                          ref={i === msgs.length - 1
                            ? (element) => {
                                stageLastMessageRefs.current[stageKey] = element
                              }
                            : undefined}
                          data-stage-last-message={i === msgs.length - 1 ? stageKey : undefined}
                          style={{
                            width: isUser ? 'fit-content' : '85%',
                            maxWidth: '85%', minWidth: 0,
                            display: 'flex', flexDirection: 'column', gap: 4,
                            alignSelf: isUser ? 'flex-end' : 'flex-start',
                          }}
                        >
                          {isUser && (
                            <div style={{ fontSize: 10, color: 'var(--meta)', textAlign: 'right', paddingRight: 44 }}>
                              {formatConversationDateTime(msg.started_at || msg.created_at)}
                            </div>
                          )}
                          {/* Message row */}
                          <div style={{
                            width: isUser ? 'fit-content' : '100%',
                            maxWidth: '100%', minWidth: 0,
                            display: 'flex', gap: 12,
                            flexDirection: isUser ? 'row-reverse' : 'row',
                          }}>
                            <div style={{
                              width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                              background: senderColor, color: '#fff',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: 12, fontWeight: 600, position: 'relative',
                            }}>
                              {initials}
                              {isReview && (
                                <span
                                  title="Review"
                                  aria-label="Review 消息"
                                  style={{
                                    position: 'absolute', right: -4, bottom: -4,
                                    width: 16, height: 16, borderRadius: '50%',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    background: '#7c3aed', color: '#fff',
                                    border: '2px solid var(--bg)',
                                    fontSize: 9, fontWeight: 800, lineHeight: 1,
                                  }}
                                >
                                  R
                                </span>
                              )}
                            </div>
                            <div style={{
                              flex: isUser ? '0 1 auto' : 1,
                              minWidth: 0, display: 'flex',
                              flexDirection: 'column', gap: 6,
                            }}>
                              {!isUser && (
                                <MessageMetaBar
                                  createdAt={msg.created_at}
                                  startedAt={msg.started_at}
                                  endedAt={msg.ended_at}
                                  running={msg.run_status === 'running'}
                                  events={processEvents}
                                  prompt={msg.prompt}
                                  onViewPrompt={setViewingPrompt}
                                />
                              )}
                              {!isUser && !isCoordinator && msg.run_status === 'running' && !msg.content && (
                                <div className="engine-loading-message" role="status" aria-live="polite">
                                  <span>{liveExecutionStatus(processEvents)}</span>
                                  <span className="engine-loading-dots" aria-hidden="true">
                                    <i />
                                    <i />
                                    <i />
                                  </span>
                                </div>
                              )}
                              {msg.content && (
                                <div style={{
                                  fontSize: 13, lineHeight: 1.6,
                                  color: isUser ? '#fff' : 'var(--fg-2)',
                                  background: isUser ? 'var(--accent)' : 'var(--surface)',
                                  padding: '10px 14px', borderRadius: 12,
                                  borderBottomRightRadius: isUser ? 4 : 12,
                                  borderBottomLeftRadius: isUser ? 12 : 4,
                                  width: isUser ? 'fit-content' : undefined,
                                  minWidth: 0, maxWidth: '100%', overflow: 'hidden',
                                }}>
                                  {isUser
                                    ? (
                                      <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                                        {msg.content}
                                      </div>
                                    )
                                    : <MarkdownMessage content={String(msg.content)} />}
                                </div>
                              )}
                              {!isUser && !isSystem && msg.content && (
                                <MessageResponseFooter
                                  content={String(msg.content)}
                                  usage={msg.usage || usageFromEvents(processEvents)}
                                  engine={msg.engine}
                                  running={msg.run_status === 'running'}
                                />
                              )}
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
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              })
            })()}

            {liveCoordinatorMessages.map((message) => (
              <div key={message.id} style={{ width: '85%', maxWidth: '85%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, alignSelf: 'flex-start' }}>
                <div style={{ width: '100%', maxWidth: '100%', minWidth: 0, display: 'flex', gap: 12 }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#7c3aed', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>协</div>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <MessageMetaBar
                      createdAt={message.created_at}
                      running={message.status === 'running'}
                      events={message.events}
                      prompt={message.prompt || livePromptOverrides[message.id]}
                      onViewPrompt={setViewingPrompt}
                    />
                    {!message.content && message.status === 'running' && (
                      <div className="engine-loading-message" role="status">协调 Agent 思考中...</div>
                    )}
                    {message.content && (
                      <>
                        <div style={{ padding: '10px 14px', borderRadius: 12, borderBottomLeftRadius: 4, background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border-soft)', minWidth: 0, maxWidth: '100%', overflow: 'hidden', fontSize: 13, lineHeight: 1.5 }}>
                          <MarkdownMessage content={message.content} streaming={message.status === 'running'} />
                        </div>
                        <MessageResponseFooter
                          content={message.content}
                          usage={usageFromEvents(message.events)}
                          engine={message.engine}
                          running={message.status === 'running'}
                        />
                      </>
                    )}
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
                  </div>
                </div>
              </div>
            ))}

            {liveExecutionMessages.map((message) => {
              const stage = stages.find((item) => item.key === message.step_key)
              const stageLabel = stage?.label || message.step_key || '执行阶段'
              return (
                <div key={message.id} style={{ width: '85%', maxWidth: '85%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ width: '100%', minWidth: 0, display: 'flex', gap: 12 }}>
                    <div title={stageLabel} aria-label={`${stageLabel}阶段`} style={{ width: 32, height: 32, borderRadius: '50%', background: stage?.color || activeStageColor, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{stageAvatarText(stageLabel)}</div>
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <MessageMetaBar
                      createdAt={message.created_at}
                      running={message.status === 'running'}
                      events={message.events}
                      prompt={message.prompt || livePromptOverrides[message.id]}
                      onViewPrompt={setViewingPrompt}
                    />
                    {!message.content && message.status === 'running' && (
                      <div className="engine-loading-message" role="status" aria-live="polite">
                        <span>{liveExecutionStatus(message.events)}</span>
                        <span className="engine-loading-dots" aria-hidden="true">
                          <i />
                          <i />
                          <i />
                        </span>
                      </div>
                    )}
                    {message.content && (
                      <>
                        <div style={{ padding: '10px 14px', borderRadius: 12, borderBottomLeftRadius: 4, background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border-soft)', minWidth: 0, maxWidth: '100%', overflow: 'hidden', fontSize: 13, lineHeight: 1.5 }}>
                          <MarkdownMessage content={message.content} streaming={message.status === 'running'} />
                        </div>
                        <MessageResponseFooter
                          content={message.content}
                          usage={usageFromEvents(message.events)}
                          engine={message.engine}
                          running={message.status === 'running'}
                        />
                      </>
                    )}
                    </div>
                  </div>
                </div>
              )
            })}

            {/* Live assistant process and response */}
            {shouldRenderLegacyExecution(
              running,
              hasProcessEvents(events),
              content,
              hasStructuredExecutionMessage,
            ) && (
              <div style={{ width: '85%', minWidth: 0, display: 'flex', gap: 12 }}>
                <div title={activeStage.label} aria-label={`${activeStage.label}阶段`} style={{ width: 32, height: 32, borderRadius: '50%', background: activeStageColor, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, flexShrink: 0 }}>{stageAvatarText(activeStage.label)}</div>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <ProcessTrace events={events} running={running} />
                  {running && !content && !hasProcessEvents(events) && (
                    <div className="engine-loading-message" role="status" aria-live="polite">
                      <span>引擎处理中</span>
                      <span className="engine-loading-dots" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                    </div>
                  )}
                  {content && (
                    <>
                      <div style={{
                        padding: '10px 14px', borderRadius: 12, borderBottomLeftRadius: 4,
                        background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border-soft)',
                        minWidth: 0, maxWidth: '100%', overflow: 'hidden',
                        fontSize: 13, lineHeight: 1.5,
                      }}>
                        <MarkdownMessage content={content} streaming={running} />
                      </div>
                      <MessageResponseFooter
                        content={content}
                        usage={usageFromEvents(events)}
                        engine={task.engine}
                        running={running}
                      />
                    </>
                  )}
                </div>
              </div>
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
          <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border-soft)', background: 'var(--bg)', display: 'flex', gap: 10, alignItems: 'flex-end', flexShrink: 0 }}>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !coordinatorRunning) { e.preventDefault(); handleRun() }
              }}
              placeholder={coordinatorRunning ? '协调 Agent 处理中...' : '输入问题、补充说明或操作请求...'}
              disabled={coordinatorRunning}
              rows={1}
              style={{
                flex: 1, fontSize: 13, padding: '10px 14px',
                border: '1px solid var(--border)', borderRadius: 8,
                resize: 'none', minHeight: 40, maxHeight: 120,
                background: 'var(--bg)', color: 'var(--fg)', outline: 'none',
                fontFamily: 'var(--font-body)', lineHeight: 1.5,
              }}
              onFocus={(e) => e.currentTarget.style.borderColor = 'var(--accent)'}
              onBlur={(e) => e.currentTarget.style.borderColor = 'var(--border)'}
            />
            <button
              onClick={handleRun}
              disabled={coordinatorRunning || !prompt.trim()}
              aria-label="发送给协调 Agent"
              title="发送给协调 Agent"
              style={{
                width: 40, height: 40, borderRadius: '50%',
                background: coordinatorRunning || !prompt.trim() ? 'var(--border)' : 'var(--accent)',
                color: coordinatorRunning || !prompt.trim() ? 'var(--meta)' : '#fff',
                border: 'none', cursor: coordinatorRunning || !prompt.trim() ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
      <div style={{ padding: '14px 24px', borderTop: '1px solid var(--border-soft)', display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0 }}>
        <button className="btn-ghost" onClick={onClose}>关闭</button>
        <button
          className="btn-primary"
          disabled={globalAdvanceState.disabled}
          onClick={globalAdvance}
          style={globalAdvanceState.disabled ? {
            background: 'var(--border)',
            color: 'var(--meta)',
            borderColor: 'var(--border)',
            cursor: 'not-allowed',
            opacity: 1,
          } : undefined}
        >
          {reviewActionPending ? '处理中…' : globalAdvanceState.label}
        </button>
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
              <strong style={{ flex: 1, fontSize: 15 }}>完整提示词</strong>
              <button type="button" className="btn-icon" aria-label="关闭提示词" onClick={() => setViewingPrompt(null)}>✕</button>
            </div>
            <div style={{ padding: 18, overflow: 'auto', fontSize: 12, lineHeight: 1.65 }}>
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
                <div style={{ fontSize: 15, fontWeight: 600 }}>快速编辑阶段提示词</div>
                <div style={{ marginTop: 2, fontSize: 11, color: 'var(--meta)' }}>{currentStage.label} · {currentStage.key}</div>
              </div>
              <button className="btn-icon" disabled={promptSaving} onClick={() => setShowPromptEditor(false)}>✕</button>
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
                <div role="alert" style={{ marginTop: 8, color: 'var(--danger)', fontSize: 12 }}>
                  {promptSaveError}
                </div>
              )}
            </div>
            <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border-soft)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn-ghost" disabled={promptSaving} onClick={() => setShowPromptEditor(false)}>取消</button>
              <button className="btn-primary" disabled={promptSaving} onClick={saveStagePrompt}>
                {promptSaving ? '保存中…' : '保存提示词'}
              </button>
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
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  {previewArtifact.logical_name || previewArtifact.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--meta)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {previewArtifact.path}
                </div>
              </div>
              <button className="btn-ghost" onClick={openArtifactDirectory}>
                打开所在目录
              </button>
              <button className="btn-icon" onClick={() => setPreviewArtifact(null)}>✕</button>
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
