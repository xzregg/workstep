import { useCompactLayout } from '../hooks/useCompactLayout'
import { randomUuid } from '../utils/uuid'
import {
  ComposerOverlayHostContext,
  useComposerOverlayClearance,
} from '../hooks/useComposerOverlayClearance'
import {
  useEffect,
  useRef,
  useState,
  useMemo,
  useCallback,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type { A2uiClientAction } from '@a2ui/web_core/v0_9'
import type { LiveMessage } from '../stores/taskStore'
import { useUserSettingsStore } from '../stores/userSettingsStore'
import { useCoordinatorEngines } from '../stores/engineAvailabilityStore'
import { usePromptEnhance } from '../hooks/usePromptEnhance'
import {
  type ActionProposal,
  type CoordinatorConfig,
  type EngineInputItem,
  type ProviderInfo,
  type ReviewRun,
  type TaskArtifact,
  type TaskArtifactInputSnapshot,
  type TaskExecutionReport,
  type TaskStepState,
} from '../api/client'
import Button from './Button'
import Input from './Input'
import Textarea from './Textarea'
import ChatMessageBubble from './ChatMessageBubble'
import AssistantThinkingMessage from './AssistantThinkingMessage'
import StreamingStatusText from './StreamingStatusText'
import ConversationNewMessagesButton from './ConversationNewMessagesButton'
import ChatInput, {
  type ChatInputEngineConfig,
  type ChatInputImageAttach,
} from './ChatInput'
import MessageMetaBar from './MessageMetaBar'
import MessageResponseFooter, {
  usageFromEvents,
} from './MessageResponseFooter'
import { stripA2uiBlocks } from '../utils/a2ui'
import MarkdownEditor from './MarkdownEditor'
import MarkdownMessage from './MarkdownMessage'
import ReviewReportContent from './ReviewReportContent'
import ReviewDecisionActions, { type ReviewDecisionAction } from './ReviewDecisionActions'
import ProcessTrace from './ProcessTrace'
import Icon from './Icon'
import PendingMessageInserts from './PendingMessageInserts'
import MarqueeText from './MarqueeText'
import TaskStepProgressGraph from './TaskStepProgressGraph'
import TaskExecutionAnalysis from './TaskExecutionAnalysis'
import TaskArtifactBrowser from './TaskArtifactBrowser'
import TaskGitWorkspace from './git/TaskGitWorkspace'
import { displayUserDetail, displayUserSender } from '../utils/actorDisplay'
import {
  isVisibleHistoryMessage,
  isVisibleLiveExecutionMessage,
  canRetryFailedExecutionMessage,
  canCompleteStoppedReview,
  isUnpersistedLiveMessage,
  isManualReviewMessage,
  isMessageReviewActionable,
  isReviewActionable,
  isLostEngineSessionError,
  isStepResumableWithMessage,
  isSelectedStepRunning,
  findPreferredArtifact,
  findStepRoundInputArtifact,
  findStepRoundInputPort,
  hasStepIoContractChanged,
  artifactsForStepRoundOutputs,
  groupStepOutputsByInput,
  downstreamInputsForOutput,
  artifactsForMessage,
  findActionablePendingReview,
  isNearConversationBottom,
  hasActiveSelectionWithin,
  shouldPauseConversationFollow,
  conversationBottomScrollTop,
  isAutoShrinkClamp,
  liveExecutionStatus,
  mergeHistoryMessageWithLive,
  messageSessionId,
  observeContentResize,
  orderConversationMessages,
  resolveTaskComposerState,
  resolveMessageError,
  resolveMessageReview,
  reviewActorLabel,
  shouldRenderLegacyExecution,
  stepAvatarText,
  taskTargetStepsInWorkflowOrder,
} from '../pages/taskDetailChat'
import {
  formatConversationDateTime,
  toMilliseconds,
} from '../utils/datetime'
import { useI18n, type TKey } from '../i18n'
import { shouldShowAssistantThinking } from '../utils/assistantThinking'
import TaskRecoveredBadge from './TaskRecoveredBadge'
import { ActionConversationMessage, TaskActionButtons, useTaskActions } from './TaskActionShortcuts'
import { mergeActionMessages } from '../utils/actionConversation'

// ─── Types ───────────────────────────────────────────────────────────────

export type StepVisualState =
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

export interface StepData {
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

export interface StepProgress extends Partial<TaskStepState> {
  visualState: StepVisualState
}

const PROCESS_EVENT_TYPES = new Set([
  'thinking_delta',
  'tool_use',
  'tool_input_delta',
  'tool_result',
])

/** 稳定空数组：避免无 events 的消息每次渲染都生成新引用，击穿下游 memo。 */
const EMPTY_EVENTS: never[] = []

const STATUS_LABEL_KEYS: Record<string, TKey> = {
  ready: 'status.ready',
  running: 'status.running',
  paused: 'status.paused',
  stopped: 'status.stopped',
  done: 'status.done',
}

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

// ─── Props ───────────────────────────────────────────────────────────────

export interface TaskDetailViewProps {
  /** The URL access context only decides whether the shared composer is present. */
  chatEnabled?: boolean

  // ── Task data ──
  task: {
    id: string
    title: string
    description?: string | null
    status: string
    steps: TaskStepState[]
    creator_id?: string | null
    creator_name?: string | null
    creator_device_id?: string | null
    creator_device_name?: string | null
    created_at: string
    updated_at?: string
    run_round?: number
    engine?: string
    model?: string | null
    restart_from_step_key?: string | null
    coordinator_engine?: string | null
    coordinator_session_id?: string | null
    active_workflow_run_id?: string | null
    review_overrides?: Record<string, any> | null
    recovered_count?: number
  } | null | undefined

  // ── Step definitions & progress ──
  steps: StepData[]
  workflowConnections?: Array<{
    from: string | number
    fromPort?: number
    to: string | number
    toPort?: number
    kind?: string
  }>
  stepProgress: StepProgress[]
  selectedStep: number
  onStepClick: (index: number) => void

  // ── Messages ──
  historyMessages: any[]
  onLoadOlderHistory?: () => void
  onLoadMessageEvents?: (messageId: string) => void
  liveMessages: Record<string, LiveMessage>
  /** 实时消息缺失 prompt 时从历史接口回填的覆盖表（失败消息也要能「查看提示词」）。 */
  livePromptOverrides?: Record<string, string>
  events: any[]
  content: string
  availableCommands?: Record<string, EngineInputItem[]>

  // ── Reviews ──
  reviews: ReviewRun[]
  reviewActionPending?: boolean
  reviewComment?: string
  onReviewCommentChange?: (value: string) => void
  onReviewAction?: (
    action: ReviewDecisionAction,
    review?: any,
    stepKey?: string,
  ) => void

  // ── Artifacts ──
  artifacts: TaskArtifact[]
  artifactInputSnapshots?: TaskArtifactInputSnapshot[]
  onOpenArtifact: (name: string, stepKey?: string, round?: number, path?: string) => void

  // ── Chat (edit mode only) ──
  chatTarget?: string | 'coordinator'
  onChatTargetChange?: (target: string | 'coordinator') => void
  coordinatorRunning?: boolean
  coordinatorConfig?: CoordinatorConfig | null
  stepEngineConfig?: ChatInputEngineConfig | null
  stepEngineConfigLoading?: boolean
  stepEngineConfigError?: string
  chatError?: string
  onChatError?: (message: string) => void
  prompt?: string
  onPromptChange?: (value: string) => void
  onSend?: () => void
  onSendPrompt?: (value: string) => void
  onActionChanged?: () => void
  onStop?: () => void
  stoppingStepKeys?: string[]
  stepResuming?: boolean
  resetStep?: boolean
  onResetStepChange?: (active: boolean) => void
  onStopStep?: (stepKey: string) => void
  /** 引擎会话丢失时，清空会话并用完整步骤提示词重跑。 */
  onRestartStepWithFreshSession?: (stepKey: string) => void
  /** 正在重建会话重跑的步骤 key，用于禁用重复点击。 */
  restartingStepKeys?: string[]
  onRetryFailedMessage?: (messageId: string) => void
  retryingFailedMessageIds?: string[]
  chatInputRef?: React.RefObject<HTMLTextAreaElement | null>
  /** Alternate attachment transport for public interactive shares. */
  chatAttachment?: ChatInputImageAttach

  // ── Pending inserts for the active step/coordinator message (edit mode only) ──
  stepInserts?: Array<{ id: string; content: string }>
  stepInsertSendingIds?: string[]
  onStepInsertRemove?: (id: string) => void
  onStepInsertSend?: (insert: { id: string; content: string }) => void
  onStepInsertEditStart?: (insert: { id: string; content: string }) => void
  onStepInsertEditSave?: (id: string) => void
  onStepInsertEditCancel?: () => void
  editingInsertId?: string | null
  editingInsertContent?: string
  onEditingInsertContentChange?: (value: string) => void
  onSendAllInserts?: () => void
  onClearInserts?: () => void
  /** 拖动排序插入队列；不传则禁用拖动。 */
  onStepInsertReorder?: (fromIndex: number, toIndex: number) => void

  // ── Coordinator config (edit mode only) ──
  onCoordinatorEngineChange?: (engineId: string) => void
  onCoordinatorProviderChange?: (providerId: string) => void
  providers?: ProviderInfo[]
  onCoordinatorModelChange?: (model: string) => void
  onCoordinatorFastModelChange?: (fastModel: string) => void
  onCoordinatorVisionModelChange?: (visionModel: string) => void
  onCoordinatorThinkingEffortChange?: (effort: string) => void
  coordinatorConfigSaving?: boolean
  coordinatorConfigError?: string
  coordinatorConfigNotice?: string
  coordinatorStopping?: boolean

  // ── Description editing (edit mode only) ──
  editingDescription?: boolean
  descriptionDraft?: string
  onDescriptionDraftChange?: (value: string) => void
  descriptionSaving?: boolean
  descriptionError?: string
  onSaveDescription?: () => void
  onCancelDescriptionEdit?: () => void
  onOpenDescriptionEditor?: () => void
  scheduledStartText?: string
  descriptionEditorLeadingActions?: React.ReactNode

  // ── Prompt editing (edit mode only) ──
  onOpenPromptEditor?: () => void

  // ── Review config (edit mode only) ──
  showReviewDrawer?: boolean
  onShowReviewDrawerChange?: (value: boolean) => void
  editReviewMode?: string
  onEditReviewModeChange?: (value: string) => void
  editReviewRetries?: number
  onEditReviewRetriesChange?: (value: number) => void
  editReviewPrompt?: string
  onEditReviewPromptChange?: (value: string) => void
  onSaveReviewConfig?: () => void

  // ── A2UI (edit mode only) ──
  onA2uiAction?: (action: A2uiClientAction) => void
  onInteractionRespond?: (
    id: string,
    response: Record<string, unknown>,
  ) => Promise<void>

  // ── Proposals (edit mode only) ──
  proposalOverrides?: Record<string, ActionProposal>
  onProposalOverride?: (proposal: ActionProposal) => void

  // ── Header / layout ──
  headerActions?: React.ReactNode
  taskHeaderExtra?: React.ReactNode
  onClose?: () => void
  onHeaderPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void
  onHeaderKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  onHeaderDoubleClick?: () => void

  // ── Scroll refs (conversation) ──
  chatScrollRef?: React.RefObject<HTMLDivElement | null>
  chatEndRef?: React.RefObject<HTMLDivElement | null>
  shouldFollowMessagesRef?: React.MutableRefObject<boolean>
  lastProgrammaticScrollTopRef?: React.MutableRefObject<number>
  stepLastMessageRefs?: React.MutableRefObject<
    Record<string, HTMLDivElement | null>
  >
  pendingStepScrollRef?: React.MutableRefObject<string | null>
  hasUnreadMessages?: boolean
  onUnreadMessagesChange?: (hasUnreadMessages: boolean) => void

  // ── Derived helpers ──
  locale: string
  durationNowMs: number
  currentStep: StepData
  activeStep: StepData
  currentStepColor: string
  activeStepColor: string
  taskCompleted: boolean
  runningSteps: StepData[]
  executionStepModel: string
  sessionIdForStep: (stepKey?: string | null) => string | null
  onViewingPromptChange: (value: string | null) => void
  running?: boolean

  // ── Project ──
  projectId?: string
  gitEnabled?: boolean
  gitProjectId?: string
  /** Public shares inject their session-scoped report loader instead of a project id. */
  executionReportLoader?: () => Promise<TaskExecutionReport>
}

// ─── Component ───────────────────────────────────────────────────────────

export default function TaskDetailView({
  chatEnabled,
  task,
  steps,
  workflowConnections = [],
  stepProgress,
  selectedStep,
  onStepClick,
  historyMessages,
  onLoadOlderHistory,
  onLoadMessageEvents,
  liveMessages,
  livePromptOverrides,
  events,
  content,
  availableCommands,
  reviews,
  reviewActionPending,
  reviewComment,
  onReviewCommentChange,
  onReviewAction,
  artifacts,
  artifactInputSnapshots = [],
  onOpenArtifact,
  // Chat
  chatTarget,
  onChatTargetChange,
  coordinatorRunning,
  coordinatorConfig,
  stepEngineConfig,
  stepEngineConfigLoading = false,
  stepEngineConfigError = '',
  chatError,
  prompt,
  onPromptChange,
  onSend,
  onSendPrompt,
  onActionChanged,
  onStop,
  stoppingStepKeys,
  stepResuming,
  resetStep,
  onResetStepChange,
  onStopStep,
  onRestartStepWithFreshSession,
  restartingStepKeys,
  onRetryFailedMessage,
  retryingFailedMessageIds,
  chatInputRef,
  chatAttachment,
  // Step inserts
  stepInserts,
  stepInsertSendingIds,
  onStepInsertRemove,
  onStepInsertSend,
  onStepInsertEditStart,
  onStepInsertEditSave,
  onStepInsertEditCancel,
  editingInsertId,
  editingInsertContent,
  onEditingInsertContentChange,
  onSendAllInserts,
  onClearInserts,
  onStepInsertReorder,
  // Coordinator
  onCoordinatorEngineChange,
  onCoordinatorProviderChange,
  providers = [],
  onCoordinatorModelChange,
  onCoordinatorFastModelChange,
  onCoordinatorVisionModelChange,
  onCoordinatorThinkingEffortChange,
  coordinatorConfigSaving,
  coordinatorConfigError,
  coordinatorConfigNotice,
  coordinatorStopping,
  // Description
  editingDescription,
  descriptionDraft,
  onDescriptionDraftChange,
  descriptionSaving,
  descriptionError,
  onSaveDescription,
  onCancelDescriptionEdit,
  onOpenDescriptionEditor,
  scheduledStartText,
  descriptionEditorLeadingActions,
  // Prompt
  onOpenPromptEditor,
  // Review config
  showReviewDrawer,
  onShowReviewDrawerChange,
  editReviewMode,
  onEditReviewModeChange,
  editReviewRetries,
  onEditReviewRetriesChange,
  editReviewPrompt,
  onEditReviewPromptChange,
  onSaveReviewConfig,
  // A2UI
  onA2uiAction,
  onInteractionRespond,
  // Proposals
  proposalOverrides,
  onProposalOverride,
  // Header
  headerActions,
  taskHeaderExtra,
  onClose,
  onHeaderPointerDown,
  onHeaderKeyDown,
  onHeaderDoubleClick,
  // Scroll
  chatScrollRef,
  chatEndRef,
  shouldFollowMessagesRef,
  lastProgrammaticScrollTopRef,
  stepLastMessageRefs,
  pendingStepScrollRef,
  hasUnreadMessages,
  onUnreadMessagesChange,
  // Derived
  locale,
  durationNowMs,
  currentStep,
  currentStepColor,
  activeStep,
  activeStepColor,
  taskCompleted,
  runningSteps,
  executionStepModel,
  sessionIdForStep,
  onViewingPromptChange,
  running,
  projectId,
  gitEnabled = false,
  gitProjectId,
  executionReportLoader,
  onChatError,
}: TaskDetailViewProps) {
  const { t } = useI18n()
  const canChat = chatEnabled ?? true
  const taskActions = useTaskActions(
    canChat && onSendPrompt ? projectId : undefined,
    task?.id,
    steps[selectedStep]?.key,
    onActionChanged,
  )
  const canShowAnalysis = Boolean(projectId || executionReportLoader)
  const localUserName = useUserSettingsStore((state) => state.userName)
  // 协调引擎下拉的可用性走共享状态，设置页改动后即时跟随（由 TaskDetail 拉取时播种）。
  const sharedCoordinatorEngines = useCoordinatorEngines()
  const {
    enhance,
    onInputChange: enhanceInputChanged,
  } = usePromptEnhance({
    projectId: projectId && onPromptChange ? projectId : undefined,
    getDraft: () => prompt ?? '',
    setDraft: (value) => onPromptChange?.(value),
    onError: (message) => onChatError?.(message),
    errorMessage: t('chatSession.enhanceFailed'),
  })

  // 未在运行的步骤（等待审核 / 手动停止 / 失败 / 审核驳回）仍保留在「发给谁」选择中，
  // 选中后输入消息可带提示重新执行该步骤。
  const resumableSteps = steps.filter((step) => (
    stepProgress.some((progress) => (
      progress.step_key === step.key
      && isStepResumableWithMessage(progress.status, progress.has_history)
    ))
  ))
  const resumableStatusOf = (stepKey: string): string | null => {
    const progress = stepProgress.find((item) => item.step_key === stepKey)
    const status = progress?.status
    return isStepResumableWithMessage(status, progress?.has_history)
      ? (status ?? null)
      : null
  }
  const resumableTarget = chatTarget !== 'coordinator'
    ? resumableSteps.find((step) => step.key === chatTarget) ?? null
    : null
  const targetSteps = taskTargetStepsInWorkflowOrder(
    steps,
    runningSteps.map((step) => step.key),
    resumableSteps.map((step) => step.key),
  )
  const selectedStepRunning = isSelectedStepRunning(
    chatTarget ?? 'coordinator',
    runningSteps.map((step) => step.key),
  )
  const composerState = resolveTaskComposerState({
    target: chatTarget === 'coordinator' ? 'coordinator' : 'step',
    stepRunning: selectedStepRunning,
    stepResuming: Boolean(resumableTarget && stepResuming),
    coordinatorRunning: coordinatorRunning ?? false,
    prompt: prompt ?? '',
  })

  // 「发给谁」步骤 tab 样式：背景色与对应步骤颜色一致（选中加深并加描边）。
  const stepTabStyle = (stepColor: string, selected: boolean) => ({
    padding: '4px 10px',
    borderRadius: 6,
    fontSize: 'calc(11px * var(--font-scale))',
    fontWeight: 600,
    border: selected ? `1px solid ${stepColor}` : '1px solid transparent',
    cursor: 'pointer',
    background: `color-mix(in oklab, ${stepColor}, transparent ${selected ? 82 : 93}%)`,
    color: stepColor,
    maxWidth: 140,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  })

  // Local refs for conversation scroll when not provided by parent
  const localChatScrollRef = useRef<HTMLDivElement>(null)
  const localChatEndRef = useRef<HTMLDivElement>(null)
  const localShouldFollowRef = useRef(true)
  const localLastProgrammaticRef = useRef(0)
  const localStepLastMessageRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const localPendingStepScrollRef = useRef<string | null>(null)
  const [localHasUnread, setLocalHasUnread] = useState(false)

  // ── Split ratio (draggable divider between left panel & conversation) ──
  const compact = useCompactLayout()
  const mobileReviewRef = useRef<HTMLDivElement>(null)
  const [mobileTab, setMobileTab] = useState<'conversation' | 'steps' | 'artifacts'>('conversation')
  const [detailMode, setDetailMode] = useState<'detail' | 'artifacts' | 'analysis' | 'git'>('detail')
  const SPLIT_RATIO_KEY = 'workstep:task-detail-split-ratio'
  const SPLIT_HANDLE_WIDTH = 8
  const contentSplitRef = useRef<HTMLDivElement>(null)
  const interactionCleanupRef = useRef<(() => void) | null>(null)
  const [splitRatio, setSplitRatio] = useState(() => {
    try {
      const stored = Number(sessionStorage.getItem(SPLIT_RATIO_KEY))
      if (Number.isFinite(stored) && stored > 0 && stored < 1) return stored
    } catch {
      /* ignore */
    }
    return 1 / 3
  })

  const beginSplitResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      const container = contentSplitRef.current
      if (!container) return
      const previousCursor = document.body.style.cursor
      const previousUserSelect = document.body.style.userSelect
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = ''

      const handleMove = (moveEvent: PointerEvent) => {
        const rect = container.getBoundingClientRect()
        const usableWidth = Math.max(1, rect.width - SPLIT_HANDLE_WIDTH)
        const ratio = (
          moveEvent.clientX - rect.left
        ) / usableWidth
        const clamped = Math.min(0.85, Math.max(0.15, ratio))
        setSplitRatio(clamped)
        try {
          sessionStorage.setItem(SPLIT_RATIO_KEY, String(clamped))
        } catch {
          /* ignore */
        }
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
    },
    [],
  )

  useEffect(() => () => interactionCleanupRef.current?.(), [])

  const scrollRef = chatScrollRef ?? localChatScrollRef
  const endRef = chatEndRef ?? localChatEndRef
  const followRef = shouldFollowMessagesRef ?? localShouldFollowRef
  const programmaticRef = lastProgrammaticScrollTopRef ?? localLastProgrammaticRef
  const lastScrollTopRef = useRef(0)
  const lastScrollHeightRef = useRef(0)
  const contentRef = useRef<HTMLDivElement>(null)
  const [scrolledToBottom, setScrolledToBottom] = useState(true)

  // 待插入消息面板悬浮在输入框上方，会遮住会话区底部内容：
  // 面板高度测量、底部留白与跟随钉底由共用 hook 处理，
  // 面板通过 Context 自行注册，无需在这里跟踪它的数据。
  const { registerOverlay, overlayPaddingBottom } = useComposerOverlayClearance({
    scrollRef,
    followRef,
    programmaticRef,
    scrollHeightRef: lastScrollHeightRef,
  })

  const stepLastRef = stepLastMessageRefs ?? localStepLastMessageRefs
  const pendingScrollRef = pendingStepScrollRef ?? localPendingStepScrollRef
  const unreadMessages = hasUnreadMessages ?? localHasUnread
  const setUnreadMessages = useCallback((value: boolean) => {
    if (hasUnreadMessages === undefined) setLocalHasUnread(value)
    onUnreadMessagesChange?.(value)
  }, [hasUnreadMessages, onUnreadMessagesChange])

  // Auto-scroll to bottom when new messages arrive.
  // 依赖仅含消息内容：durationNowMs 每秒 tick 触发的重渲染不应强制钉底，
  // 否则 LLM 输出期间用户无法滚动查看历史。
  useEffect(() => {
    const container = scrollRef.current
    if (container && hasActiveSelectionWithin(
      container,
      container.ownerDocument.getSelection(),
    )) {
      followRef.current = false
      lastScrollHeightRef.current = container.scrollHeight
      setScrolledToBottom(false)
      setUnreadMessages(true)
      return
    }
    if (followRef.current) {
      if (container) {
        const target = conversationBottomScrollTop(
          container.scrollHeight,
          container.clientHeight,
        )
        programmaticRef.current = target
        lastScrollHeightRef.current = container.scrollHeight
        container.scrollTop = target
        setScrolledToBottom(isNearConversationBottom(
          container.scrollHeight,
          target,
          container.clientHeight,
        ))
      }
      setUnreadMessages(false)
    } else {
      if (container) lastScrollHeightRef.current = container.scrollHeight
      setScrolledToBottom(false)
      setUnreadMessages(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyMessages, liveMessages, events, content])

  // Media load re-scroll
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const onMediaLoad = () => {
      if (!followRef.current) return
      const target = conversationBottomScrollTop(
        container.scrollHeight,
        container.clientHeight,
      )
      programmaticRef.current = target
      lastScrollHeightRef.current = container.scrollHeight
      container.scrollTop = target
      setScrolledToBottom(isNearConversationBottom(
        container.scrollHeight,
        target,
        container.clientHeight,
      ))
    }
    container.addEventListener('load', onMediaLoad, true)
    return () => container.removeEventListener('load', onMediaLoad, true)
  }, [scrollRef, followRef, programmaticRef])

  // 展开、折叠思考块 / 过程追踪等只改变内容高度，不会触发上面的消息数据
  // effect；用 ResizeObserver 监测内容高度变化，跟随中时重新钉底，
  // 避免运行中展开块后用户被顶出底部且无法滚回。
  useEffect(() => {
    return observeContentResize({
      containerRef: scrollRef,
      contentRef,
      onResize: ({ height }) => {
        const container = scrollRef.current
        if (!container || !followRef.current) return
        lastScrollHeightRef.current = height
        const target = conversationBottomScrollTop(
          container.scrollHeight,
          container.clientHeight,
        )
        programmaticRef.current = target
        container.scrollTop = target
        setScrolledToBottom(isNearConversationBottom(
          container.scrollHeight,
          target,
          container.clientHeight,
        ))
      },
    })
  }, [scrollRef, followRef, programmaticRef])

  // ── Helpers ──

  const persistedMessageIds = useMemo(
    () => new Set(historyMessages.map((message) => String(message.id))),
    [historyMessages],
  )

  const liveCoordinatorMessages = useMemo(
    () =>
      Object.values(liveMessages).filter(
        (message) =>
          message.channel === 'coordinator' &&
          isUnpersistedLiveMessage(message, persistedMessageIds),
      ),
    [liveMessages, persistedMessageIds],
  )

  const liveExecutionMessages = useMemo(
    () =>
      Object.values(liveMessages).filter(
        (message) =>
          isVisibleLiveExecutionMessage(message) &&
          isUnpersistedLiveMessage(message, persistedMessageIds),
      ),
    [liveMessages, persistedMessageIds],
  )

  const showCoordinatorThinking = shouldShowAssistantThinking(
    coordinatorRunning ?? false,
    [...historyMessages, ...liveCoordinatorMessages],
    'coordinator',
  )

  const hasStructuredExecutionMessage = useMemo(
    () =>
      Object.values(liveMessages).some(
        (message) => message.channel === 'execution',
      ) ||
      historyMessages.some((message) => message.channel === 'execution'),
    [historyMessages, liveMessages],
  )


  const selectedReview = reviews.find(
    (review) => review.step_key === currentStep.key,
  )
  const actionablePendingReview = useMemo(
    () => findActionablePendingReview(reviews, stepProgress),
    [reviews, stepProgress],
  )
  const selectedReviewActor = selectedReview
    ? reviewActorLabel(selectedReview)
    : undefined
  const selectedReviewActionable = isReviewActionable(
    selectedReview,
    reviews,
    stepProgress[selectedStep]?.status,
  )
  const currentStepArtifactRounds = useMemo(() => {
    const rounds = new Set<number>()
    artifacts.forEach((artifact) => {
      if (artifact.step_key === currentStep.key && artifact.round) {
        rounds.add(artifact.round)
      }
    })
    return [...rounds].sort((a, b) => a - b)
  }, [artifacts, currentStep.key])
  const [selectedIoRound, setSelectedIoRound] = useState<number | null>(null)
  const activeIoRound = selectedIoRound && currentStepArtifactRounds.includes(selectedIoRound)
    ? selectedIoRound
    : currentStepArtifactRounds[currentStepArtifactRounds.length - 1]
  const selectedExecutionRound = activeIoRound ?? stepProgress[selectedStep]?.artifact_round ?? undefined
  const currentStepProgress = stepProgress[selectedStep]
  const currentStepRestarting = (restartingStepKeys ?? []).includes(currentStep.key)
  const canRerunCurrentStep = canChat
    && Boolean(onRestartStepWithFreshSession)
    && Boolean(currentStepProgress?.has_history)
    && hasStepIoContractChanged(currentStep, currentStepProgress?.io_contract)
    && !['running', 'reviewing', 'retrying', 'rework', 'rework_waiting'].includes(
      currentStepProgress?.status ?? '',
    )

  useEffect(() => {
    setSelectedIoRound(null)
  }, [currentStep.key])

  const findArtifact = (
    name: string,
    preferredStepKey?: string,
    source?: TaskArtifact[],
    preferredRound?: number,
  ) => {
    return findPreferredArtifact(source || artifacts, name, preferredStepKey, preferredRound)
  }

  const formatArtifactUpdatedAt = useCallback((value?: string | null) => {
    const milliseconds = toMilliseconds(value)
    if (milliseconds === null) return ''
    return new Date(milliseconds).toLocaleString(locale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }, [locale])

  const renderMessageArtifacts = (
    messageArtifacts: TaskArtifact[],
    stepColor?: string,
  ) => messageArtifacts.length > 0 ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
      <div style={{
        fontSize: 'calc(11px * var(--font-scale))',
        fontWeight: 600,
        color: 'var(--muted)',
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
      }}>
        {t('taskDetail.reviewArtifacts')}
      </div>
      {messageArtifacts.map((artifact) => (
        <div
          key={artifact.path}
          role="button"
          tabIndex={0}
          aria-label={t('taskDetail.openOutputAria', { name: artifact.name })}
          onClick={() => onOpenArtifact(
            artifact.name,
            artifact.step_key,
            artifact.round,
            artifact.path,
          )}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onOpenArtifact(
                artifact.name,
                artifact.step_key,
                artifact.round,
                artifact.path,
              )
            }
          }}
          title={t('taskDetail.openFileTitle', { name: artifact.name })}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
            background: 'var(--surface)', borderRadius: 6,
            border: '1px solid var(--border-soft)', cursor: 'pointer',
            fontSize: 'calc(13px * var(--font-scale))',
          }}
        >
          {artifact.is_dir ? (
            <Icon name="folder" size={14} color="var(--accent)" style={{ flexShrink: 0 }} />
          ) : (
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: stepColor || 'var(--accent)', flexShrink: 0,
            }} />
          )}
          <span style={{ flex: 1, fontWeight: 500 }}>
            {artifact.name}
            {artifact.round ? (
              <span style={{ marginLeft: 6, color: 'var(--muted)' }}>
                {t('taskDetail.artifactRound', { round: artifact.round })}
              </span>
            ) : null}
          </span>
          <span style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--accent)' }}>
            {t('common.open')}
          </span>
        </div>
      ))}
    </div>
  ) : null

  const renderArtifactPanel = () => (
    <TaskArtifactBrowser
      artifacts={artifacts}
      steps={steps}
      onOpenArtifact={onOpenArtifact}
    />
  )

  const handleStepClick = (stepIndex: number) => {
    onStepClick(stepIndex)
    const stepKey = steps[stepIndex]?.key
    if (!stepKey) return
    pendingScrollRef.current = stepKey
    requestAnimationFrame(() => {
      stepLastRef.current[stepKey]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
      pendingScrollRef.current = null
    })
  }

  // ── Render: Header ──

  const renderHeader = () => {
    if (!task) return null
    const time = new Date(task.created_at).toLocaleString(locale)
    const draggable = Boolean(onHeaderPointerDown)

    return (
      <div
        className="task-detail-header"
        role={draggable ? 'group' : undefined}
        tabIndex={draggable ? 0 : undefined}
        aria-label={draggable ? t('taskDetail.dragWindowAria') : undefined}
        title={draggable ? t('taskDetail.dragWindowTitle') : undefined}
        onPointerDown={onHeaderPointerDown}
        onKeyDown={onHeaderKeyDown}
        onDoubleClick={onHeaderDoubleClick}
        style={{
          padding: '10px',
          borderBottom: '1px solid var(--border-soft)',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          flexShrink: 0,
          ...(draggable ? { cursor: 'move' } : {}),
        }}
      >
        {draggable && (
          <span
            aria-hidden="true"
            style={{ cursor: 'move', lineHeight: 1 }}
          >
            ⠿
          </span>
        )}
        <div style={{ flex: 1 }}>
          <div
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            <span className="task-detail-title" style={{ fontSize: 'calc(20px * var(--font-scale))', fontWeight: 600, lineHeight: 1.4 }}>
              {task.title}
            </span>
            {headerActions}
            {taskHeaderExtra}
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                minHeight: 22,
                fontSize: 'calc(11px * var(--font-scale))',
                fontWeight: 500,
                padding: '0 8px',
                borderRadius: 4,
                lineHeight: 1,
                background: `color-mix(in oklab, ${activeStepColor}, transparent 85%)`,
                color: activeStepColor,
              }}
            >
              {t('taskDetail.currentStep', { step: activeStep.label })}
            </span>
            <TaskRecoveredBadge
              status={task.status}
              recoveredCount={task.recovered_count}
              className="task-detail-recovered-badge"
            />
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                minHeight: 22,
                fontSize: 'calc(11px * var(--font-scale))',
                fontWeight: 500,
                padding: '0 8px',
                borderRadius: 4,
                lineHeight: 1,
                background: `color-mix(in oklab, var(--status-${
                  taskCompleted
                    ? 'done'
                    : task.status === 'ready'
                      ? 'ready'
                      : task.status
                }), transparent 85%)`,
                color: `var(--status-${
                  taskCompleted
                    ? 'done'
                    : task.status === 'ready'
                      ? 'ready'
                      : task.status
                })`,
              }}
            >
              {t(
                STATUS_LABEL_KEYS[
                  taskCompleted ? 'done' : task.status
                ] ?? (task.status as TKey),
              )}
            </span>
            {task.creator_name && (
              <span
                title={task.creator_device_name ? `${task.creator_name} · ${task.creator_device_name}` : task.creator_name}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  minHeight: 22,
                  fontSize: 'calc(12px * var(--font-scale))',
                  lineHeight: 1,
                  color: 'var(--meta)',
                }}
              >
                {t('taskDetail.creator')}：{task.creator_name}
              </span>
            )}
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                minHeight: 22,
                fontSize: 'calc(13px * var(--font-scale))',
                lineHeight: 1,
                color: 'var(--meta)',
              }}
            >
              {time}
            </span>
          </div>
        </div>
        {onClose && (
          <Button
            variant="icon"
            aria-label={t('common.close')}
            title={t('common.close')}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onClose}
            style={{ padding: 0, flexShrink: 0 }}
          >
            <Icon name="x" size={16} />
          </Button>
        )}
      </div>
    )
  }

  // ── Render: Left panel ──

  const renderLeftPanel = () => {
    if (!task) return null
    return (
      <div
        style={{
          minWidth: 0,
          overflowY: 'auto',
          padding: '20px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
        }}
      >
        {/* Description */}
        <div>
          <div
            className="task-description-header"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
              <div
                style={{
                  fontSize: 'calc(11px * var(--font-scale))',
                  fontWeight: 600,
                  color: 'var(--muted)',
                  fontFamily: 'var(--font-mono)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                }}
              >
                {t('taskDetail.description')}
              </div>
              {scheduledStartText && (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    color: 'var(--meta)',
                    fontSize: 'calc(11px * var(--font-scale))',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <Icon name="clock" size={11} strokeWidth={2} />
                  {scheduledStartText}
                </span>
              )}
            </div>
            {onOpenDescriptionEditor && !editingDescription && (
              <Button
                variant="ghost"
                aria-label={t('taskDetail.editDescriptionAria')}
                onClick={onOpenDescriptionEditor}
                style={{ height: 28, padding: '0 9px', fontSize: 'calc(11px * var(--font-scale))', gap: 4 }}
              >
                <span aria-hidden="true">✎</span>
                {t('common.edit')}
              </Button>
            )}
          </div>
          {editingDescription ? (
            <div>
              <MarkdownEditor
                value={descriptionDraft ?? ''}
                onChange={onDescriptionDraftChange ?? (() => {})}
                projectId={projectId}
                imagePrefix={task.id.slice(0, 8)}
                placeholder={t('taskDetail.descriptionPlaceholder')}
                minHeight={140}
                maxHeight="33vh"
                disabled={descriptionSaving}
                autoFocus
              />
              {descriptionError && (
                <div
                  role="alert"
                  style={{
                    marginTop: 6,
                    color: 'var(--danger)',
                    fontSize: 'calc(11px * var(--font-scale))',
                  }}
                >
                  {descriptionError}
                </div>
              )}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  justifyContent: 'flex-end',
                  gap: 8,
                  marginTop: 8,
                }}
              >
                {descriptionEditorLeadingActions && (
                  <div style={{ marginRight: 'auto' }}>
                    {descriptionEditorLeadingActions}
                  </div>
                )}
                <Button
                  variant="ghost"
                  disabled={descriptionSaving}
                  onClick={onCancelDescriptionEdit}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  disabled={descriptionSaving}
                  loading={descriptionSaving}
                  onClick={onSaveDescription}
                >
                  {t('common.save')}
                </Button>
              </div>
            </div>
          ) : (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid var(--border-soft)',
                fontSize: 'calc(13px * var(--font-scale))',
                lineHeight: 1.6,
                overflowWrap: 'anywhere',
                maxHeight: '33vh',
                overflowY: 'auto',
              }}
            >
              {task.description ? (
                <MarkdownMessage
                  content={task.description}
                  projectId={projectId}
                />
              ) : (
                <span
                  style={{
                    color: 'var(--meta)',
                    fontStyle: 'italic',
                  }}
                >
                  {t('taskDetail.noDescription')}
                </span>
              )}
            </div>
          )}
        </div>


        <TaskStepProgressGraph
          taskStatus={task?.status ?? 'ready'}
          runRound={task?.run_round ?? 1}
          restartFromStepKey={task?.restart_from_step_key ?? undefined}
          steps={steps}
          stepProgress={stepProgress}
          artifacts={artifacts}
          selectedStep={selectedStep}
          durationNowMs={durationNowMs}
          onStepClick={handleStepClick}
        />

        {/* I/O section */}
        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              marginBottom: 8,
            }}
          >
            <span style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>
              {t('taskDetail.stepIo')}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              {canRerunCurrentStep && (
                <Button
                  size="sm"
                  loading={currentStepRestarting}
                  disabled={currentStepRestarting}
                  onClick={() => onRestartStepWithFreshSession?.(currentStep.key)}
                >
                  {currentStepRestarting
                    ? t('taskDetail.rerunningLatestWorkflow')
                    : t('taskDetail.rerunLatestWorkflow')}
                </Button>
              )}
              {currentStepArtifactRounds.length > 0 && (
              <span
                role="tablist"
                aria-label={t('taskDetail.artifactRoundTabsAria')}
                style={{
                  display: 'flex',
                  gap: 4,
                  overflowX: 'auto',
                  minWidth: 0,
                }}
              >
                {currentStepArtifactRounds.map((round) => {
                  const selected = round === activeIoRound
                  return (
                    <button
                      key={round}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      onClick={() => setSelectedIoRound(round)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        height: 24,
                        padding: '0 7px',
                        borderRadius: 4,
                        border: '1px solid var(--border-soft)',
                        background: selected ? 'var(--accent)' : 'var(--surface)',
                        color: selected ? 'var(--accent-fg)' : 'var(--meta)',
                        fontSize: 'calc(11px * var(--font-scale))',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <span>{t('taskDetail.artifactRoundTab', { round })}</span>
                    </button>
                  )
                })}
              </span>
              )}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <div
                style={{
                  fontSize: 'calc(13px * var(--font-scale))',
                  fontWeight: 600,
                  color: 'var(--muted)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span style={{ color: 'var(--meta)' }}>→</span>{' '}
                {t('taskDetail.ioInput')}
              </div>
              {(() => {
                const producedOutputs = artifactsForStepRoundOutputs(
                  artifacts,
                  currentStep.key,
                  activeIoRound,
                )
                const outputsByInput = groupStepOutputsByInput(
                  currentStep.inputs || [],
                  currentStep.outputs || [],
                  producedOutputs,
                )

                return (currentStep.inputs || []).map(
                  (inp: any, inpIdx: number) => {
                    const subOutputs = outputsByInput[inpIdx] || []
                    const inputPortSnapshot = findStepRoundInputPort(
                      artifactInputSnapshots,
                      currentStep.key,
                      selectedExecutionRound,
                      inpIdx,
                    )
                    const snapshotInputArtifact = findStepRoundInputArtifact(
                      artifacts,
                      artifactInputSnapshots,
                      currentStep.key,
                      selectedExecutionRound,
                      inpIdx,
                    )
                    const inputArtifact = snapshotInputArtifact
                      ?? (inputPortSnapshot ? undefined : findArtifact(inp.name))
                    const inputIsTaskContext = inputPortSnapshot?.status === 'task_context'
                    const inputIsInactive = inputPortSnapshot?.status === 'inactive'
                    const inputStatusLabel = inputArtifact
                      ? t('taskDetail.inputReady')
                      : inputIsTaskContext
                        ? t('taskDetail.inputTaskContext')
                        : inputIsInactive
                          ? t('taskDetail.inputInactive')
                          : t('taskDetail.inputUnavailable')
                    const inputUpdatedAt = formatArtifactUpdatedAt(inputArtifact?.updated_at)
                    return (
                      <div
                        key={inpIdx}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                        }}
                      >
                        {/* Input item */}
                        <div
                          role={inputArtifact ? 'button' : undefined}
                          tabIndex={inputArtifact ? 0 : undefined}
                          aria-label={inputArtifact
                            ? t('taskDetail.openInputAria', { name: inp.name })
                            : undefined}
                          onClick={inputArtifact
                            ? () => onOpenArtifact(
                              inputArtifact.name,
                              inputArtifact.step_key,
                              inputArtifact.round,
                              inputArtifact.path,
                            )
                            : undefined}
                          onKeyDown={(event) => {
                            if (inputArtifact && (
                              event.key === 'Enter' ||
                              event.key === ' '
                            )) {
                              event.preventDefault()
                              onOpenArtifact(
                                inputArtifact.name,
                                inputArtifact.step_key,
                                inputArtifact.round,
                                inputArtifact.path,
                              )
                            }
                          }}
                          title={inputArtifact
                            ? t('taskDetail.openFileTitle', { name: inp.name })
                            : undefined}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '8px 10px',
                            background: 'var(--surface)',
                            borderRadius: 6,
                            border: '1px solid var(--border-soft)',
                            cursor: inputArtifact ? 'pointer' : 'default',
                          }}
                        >
                          {inputUpdatedAt && (
                            <span
                              title={t('taskDetail.artifactModifiedAt', { time: inputUpdatedAt })}
                              style={{
                                width: 82,
                                flexShrink: 0,
                                color: 'var(--meta)',
                                fontSize: 'calc(11px * var(--font-scale))',
                                fontVariantNumeric: 'tabular-nums',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {inputUpdatedAt}
                            </span>
                          )}
                          <div
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: '50%',
                              background: 'var(--accent)',
                              flexShrink: 0,
                            }}
                          />
                          <span
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              flex: 1,
                              minWidth: 0,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 'calc(13px * var(--font-scale))',
                                fontWeight: 500,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                minWidth: 0,
                              }}
                            >
                              {inp.name}
                            </span>
                            <span
                              style={{
                                fontSize: 'calc(11px * var(--font-scale))',
                                color: 'var(--meta)',
                                background: 'var(--surface)',
                                border: '1px solid var(--border-soft)',
                                padding: '0 4px',
                                borderRadius: 3,
                                flexShrink: 0,
                              }}
                            >
                              {inp.type}
                            </span>
                          </span>
                          {inputArtifact?.round ? (
                            <span
                              style={{
                                fontSize: 'calc(11px * var(--font-scale))',
                                color: 'var(--meta)',
                                background: 'var(--surface)',
                                border: '1px solid var(--border-soft)',
                                padding: '0 3px',
                                borderRadius: 2,
                                flexShrink: 0,
                              }}
                            >
                              {t('taskDetail.artifactRound', {
                                round: inputArtifact.round,
                              })}
                            </span>
                          ) : null}
                          <span
                            style={{
                              fontSize: 'calc(11px * var(--font-scale))',
                              color: inputArtifact || inputIsTaskContext
                                ? 'var(--success)'
                                : 'var(--meta)',
                              background: 'var(--surface)',
                              border: '1px solid var(--border-soft)',
                              padding: '0 3px',
                              borderRadius: 2,
                              flexShrink: 0,
                            }}
                          >
                            {inputStatusLabel}
                          </span>
                          {inputArtifact ? (
                            <span
                              style={{
                                fontSize: 'calc(11px * var(--font-scale))',
                                color: 'var(--accent)',
                              }}
                            >
                              {t('taskDetail.view')}
                            </span>
                          ) : null}
                        </div>
                        {/* Sub-outputs */}
                        {subOutputs.map(
                          (out: any, outIdx: number) => {
                            const downstreamInputs = downstreamInputsForOutput(
                              steps,
                              workflowConnections,
                              currentStep.key,
                              out.outputIndex,
                            )
                            const downstreamLabels = downstreamInputs.map((target) =>
                              `→ ${target.stepLabel}: ${target.inputName}`,
                            )
                            const outArtifact = out.artifact ?? findArtifact(
                              out.name,
                              currentStep.key,
                              undefined,
                              activeIoRound,
                            )
                            const outputUpdatedAt = formatArtifactUpdatedAt(outArtifact?.updated_at)
                            const outputReady = Boolean(outArtifact)
                            return (
                              <div
                                key={outIdx}
                                role={outputReady ? 'button' : undefined}
                                tabIndex={outputReady ? 0 : undefined}
                                aria-label={outputReady
                                  ? t(
                                    'taskDetail.openOutputAria',
                                    { name: out.name },
                                  )
                                  : undefined}
                                onClick={outputReady
                                  ? () =>
                                    onOpenArtifact(
                                      outArtifact?.name ?? out.name,
                                      currentStep.key,
                                      activeIoRound,
                                      outArtifact?.path,
                                    )
                                  : undefined}
                                onKeyDown={outputReady
                                  ? (event) => {
                                    if (
                                      event.key === 'Enter' ||
                                      event.key === ' '
                                    ) {
                                      event.preventDefault()
                                      onOpenArtifact(
                                        outArtifact?.name ?? out.name,
                                        currentStep.key,
                                        activeIoRound,
                                        outArtifact?.path,
                                      )
                                    }
                                  }
                                  : undefined}
                                title={outputReady
                                  ? t('taskDetail.openFileTitle', {
                                    name: out.name,
                                  })
                                  : undefined}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  marginLeft: 18,
                                  padding: '4px 8px',
                                  cursor: outputReady ? 'pointer' : 'default',
                                  borderRadius: 4,
                                }}
                              >
                                <span
                                  style={{
                                    color: 'var(--meta)',
                                    fontSize: 'calc(11px * var(--font-scale))',
                                  }}
                                >
                                  ↳
                                </span>
                                {outputUpdatedAt && (
                                  <span
                                    title={t('taskDetail.artifactModifiedAt', { time: outputUpdatedAt })}
                                    style={{
                                      width: 82,
                                      flexShrink: 0,
                                      color: 'var(--meta)',
                                      fontSize: 'calc(11px * var(--font-scale))',
                                      fontVariantNumeric: 'tabular-nums',
                                      whiteSpace: 'nowrap',
                                    }}
                                  >
                                    {outputUpdatedAt}
                                  </span>
                                )}
                                {outArtifact?.is_dir ? (
                                  <Icon
                                    name="folder"
                                    size={13}
                                    color="var(--accent)"
                                    style={{ flexShrink: 0 }}
                                  />
                                ) : (
                                  <div
                                    style={{
                                      width: 6,
                                      height: 6,
                                      borderRadius: '50%',
                                      background: outputReady
                                        ? 'var(--success)'
                                        : 'var(--border-soft)',
                                      flexShrink: 0,
                                    }}
                                  />
                                )}
                                <span
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    flex: '0 1 auto',
                                    minWidth: 0,
                                  }}
                                >
                                  <span
                                    style={{
                                      fontSize: 'calc(13px * var(--font-scale))',
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      whiteSpace: 'nowrap',
                                      minWidth: 0,
                                    }}
                                  >
                                    {out.name}
                                  </span>
                                  <span
                                    style={{
                                      fontSize: 'calc(11px * var(--font-scale))',
                                      color: 'var(--meta)',
                                      background: 'var(--surface)',
                                      border: '1px solid var(--border-soft)',
                                      padding: '0 3px',
                                      borderRadius: 2,
                                      flexShrink: 0,
                                    }}
                                  >
                                    {out.type}
                                  </span>
                                </span>
                                {downstreamInputs.length > 0 && (
                                  <MarqueeText
                                    className="step-output-route-marquee"
                                    text={downstreamLabels.join('   ')}
                                    title={downstreamLabels.join('\n')}
                                    style={{
                                      flex: '0 1 35%',
                                      width: '35%',
                                      fontSize: 'calc(11px * var(--font-scale))',
                                      color: 'var(--muted)',
                                    }}
                                  />
                                )}
                                <span style={{ flex: 1, minWidth: 0 }} aria-hidden="true" />
                                {outArtifact?.round ? (
                                  <span
                                    style={{
                                      fontSize: 'calc(11px * var(--font-scale))',
                                      color: 'var(--meta)',
                                      background: 'var(--surface)',
                                      border: '1px solid var(--border-soft)',
                                      padding: '0 3px',
                                      borderRadius: 2,
                                      flexShrink: 0,
                                    }}
                                  >
                                    {t('taskDetail.artifactRound', {
                                      round: outArtifact.round,
                                    })}
                                  </span>
                                ) : null}
                                <span
                                  style={{
                                    fontSize: 'calc(11px * var(--font-scale))',
                                    color: 'var(--meta)',
                                    background: 'var(--surface)',
                                    border: '1px solid var(--border-soft)',
                                    padding: '0 3px',
                                    borderRadius: 2,
                                    flexShrink: 0,
                                  }}
                                >
                                  {outputReady
                                    ? t('taskDetail.outputDone')
                                    : t('taskDetail.outputPending')}
                                </span>
                                {outputReady && (
                                  <span
                                    style={{
                                      fontSize: 'calc(11px * var(--font-scale))',
                                      color: 'var(--accent)',
                                      flexShrink: 0,
                                    }}
                                  >
                                    {t('common.open')}
                                  </span>
                                )}
                              </div>
                            )
                          },
                        )}
                      </div>
                    )
                  },
                )
              })()}
            </div>
          </div>
        </div>

        {/* Step prompt */}
        <div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              color: `${currentStepColor}`,
            }}
          >
            {' '}
            {currentStep.label}{' '}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 12,
            }}
          >
            <div
              style={{
                fontSize: 'calc(11px * var(--font-scale))',
                fontWeight: 600,
                color: 'var(--muted)',
                fontFamily: 'var(--font-mono)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              {t('taskDetail.stepPrompt')}
            </div>
            {onOpenPromptEditor && (
              <Button
                variant="ghost"
                onClick={onOpenPromptEditor}
                style={{ height: 28, padding: '0 9px', fontSize: 'calc(13px * var(--font-scale))', gap: 4 }}
              >
                <span aria-hidden="true">✎</span>
                {t('taskDetail.quickEdit')}
              </Button>
            )}
          </div>
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              border: '1px solid var(--border-soft)',
              fontSize: 'calc(13px * var(--font-scale))',
              lineHeight: 1.6,
              overflowWrap: 'anywhere',
              maxHeight: '33vh',
              overflowY: 'auto',
            }}
          >
            {currentStep.prompt ? (
              <MarkdownMessage
                content={currentStep.prompt}
                projectId={projectId}
              />
            ) : (
              <div style={{ fontSize: 'calc(13px * var(--font-scale))', color: 'var(--meta)' }}>
                {t('taskDetail.noStepPrompt')}
              </div>
            )}
          </div>
        </div>

        {/* Review results */}
        {selectedReview && (
          <div ref={mobileReviewRef}>
            <div
              style={{
                fontSize: 'calc(11px * var(--font-scale))',
                fontWeight: 600,
                color: 'var(--muted)',
                fontFamily: 'var(--font-mono)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginBottom: 10,
              }}
            >
              {t('taskDetail.reviewResult')}
            </div>
            <div
              style={{
                border: '1px solid var(--border-soft)',
                borderRadius: 8,
                background: 'var(--surface)',
                padding: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 9,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <strong style={{ fontSize: 'calc(13px * var(--font-scale))' }}>
                  {selectedReview.mode === 'auto'
                    ? t('taskDetail.autoReview')
                    : t('taskDetail.manualReview')}
                </strong>
                <span
                  className="status-badge"
                  data-s={
                    selectedReview.status === 'passed'
                      ? 'passed'
                      : selectedReview.status === 'rejected'
                        ? 'failed'
                        : 'paused'
                  }
                >
                  {selectedReview.status === 'passed'
                    ? t('taskDetail.reviewPassed')
                    : selectedReview.status === 'rejected'
                      ? t('taskDetail.reviewRejected')
                      : selectedReview.status === 'terminated'
                        ? t('taskDetail.reviewTerminated')
                      : selectedReview.status === 'running'
                        ? t('taskDetail.reviewRunning')
                        : t('taskDetail.reviewWaiting')}
                </span>
              </div>
              {/* 审核报告是 Markdown 文本，统一走 ReviewReportContent 按 Markdown 渲染：
                  分享页与 owner 弹窗都经 TaskDetailView 渲染，复用同一份实现。 */}
              {selectedReview.report && (
                <ReviewReportContent
                  scoreLabel={
                    selectedReview.report.score !== null
                      ? t('taskDetail.scorePoints', {
                          score: selectedReview.report.score,
                        })
                      : ''
                  }
                  report={selectedReview.report}
                  projectId={projectId}
                />
              )}
              {selectedReview.decision && selectedReviewActor && (
                <div style={{ fontSize: 'calc(12px * var(--font-scale))', color: 'var(--muted)' }}>
                  {t('taskDetail.reviewedBy', {
                    name: selectedReviewActor,
                  })}
                </div>
              )}
              {/* Review action buttons (edit mode only) */}
              {onReviewAction && selectedReviewActionable && (
                  <>
                    <Textarea
                      rows={2}
                      value={reviewComment ?? ''}
                      onChange={(event) =>
                        onReviewCommentChange?.(event.target.value)
                      }
                      placeholder={t(
                        'taskDetail.reviewCommentPlaceholder',
                      )}
                    />
                    <ReviewDecisionActions
                      status={selectedReview.status}
                      pending={!!reviewActionPending}
                      onAction={(decision) => onReviewAction?.(decision)}
                    />
                  </>
                )}
            </div>
          </div>
        )}

        {/* Review config drawer (edit mode only) */}
        {onShowReviewDrawerChange && (
          <div style={{ marginTop: 20 }}>
            <button
              onClick={() =>
                onShowReviewDrawerChange?.(!showReviewDrawer)
              }
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--muted)',
                fontSize: 'calc(11px * var(--font-scale))',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                padding: '0',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <span
                style={{
                  transform: showReviewDrawer
                    ? 'rotate(90deg)'
                    : 'none',
                  transition: 'transform 150ms',
                  display: 'inline-block',
                  fontSize: 'calc(11px * var(--font-scale))',
                }}
              >
                &#9654;
              </span>
              {t('taskDetail.stepReviewConfig')}
            </button>
            {showReviewDrawer && (
              <div
                style={{
                  marginTop: 10,
                  padding: '10px 12px',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      gap: 4,
                      alignItems: 'center',
                    }}
                  >
                    {([
                      ['skip', t('flow.reviewSkip')],
                      ['auto', t('flow.autoReview')],
                      ['manual', t('flow.manualReview')],
                    ] as const).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() =>
                          onEditReviewModeChange?.(value)
                        }
                        style={{
                          padding: '3px 10px',
                          fontSize: 'calc(12px * var(--font-scale))',
                          borderRadius: 999,
                          border:
                            editReviewMode === value
                              ? '1px solid var(--accent)'
                              : '1px solid var(--border)',
                          background:
                            editReviewMode === value
                              ? 'color-mix(in oklab, var(--accent), transparent 88%)'
                              : 'transparent',
                          color:
                            editReviewMode === value
                              ? 'var(--accent)'
                              : 'var(--fg-2)',
                          cursor: 'pointer',
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {editReviewMode === 'auto' && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 'calc(13px * var(--font-scale))',
                      }}
                    >
                      <span
                        style={{
                          color: 'var(--meta)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {t('flow.retry')}
                      </span>
                      <Input
                        type="number"
                        min={1}
                        max={5}
                        value={editReviewRetries ?? 1}
                        onChange={(e) =>
                          onEditReviewRetriesChange?.(
                            Math.max(
                              1,
                              Math.min(
                                5,
                                Number(e.target.value) || 1,
                              ),
                            ),
                          )
                        }
                        style={{
                          width: 40,
                          height: 22,
                          fontSize: 'calc(13px * var(--font-scale))',
                          padding: '0 6px',
                          border: '1px solid var(--border)',
                          borderRadius: 4,
                          background: 'var(--bg)',
                          color: 'var(--fg)',
                        }}
                      />
                      <span
                        style={{
                          fontSize: 'calc(11px * var(--font-scale))',
                          color: 'var(--meta)',
                        }}
                      >
                        {t('flow.reviewAutoRetryHint')}
                      </span>
                    </div>
                  )}
                  {editReviewMode === 'skip' && (
                    <div
                      style={{
                        fontSize: 'calc(11px * var(--font-scale))',
                        color: 'var(--meta)',
                      }}
                    >
                      {t('flow.reviewSkipHint')}
                    </div>
                  )}
                  {editReviewMode === 'manual' && (
                    <div
                      style={{
                        fontSize: 'calc(11px * var(--font-scale))',
                        color: 'var(--meta)',
                      }}
                    >
                      {t('flow.reviewPauseHint')}
                    </div>
                  )}
                </div>
                <MarkdownEditor
                  value={editReviewPrompt ?? ''}
                  onChange={
                    onEditReviewPromptChange ?? (() => {})
                  }
                  projectId={projectId}
                  placeholder={t(
                    'taskDetail.reviewPromptPlaceholder',
                  )}
                  minHeight={64}
                  maxHeight={160}
                  ariaLabel={t('taskDetail.reviewPromptAria')}
                />
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                  }}
                >
                  <Button
                    variant="ghost"
                    onClick={onSaveReviewConfig}
                    style={{
                      fontSize: 'calc(11px * var(--font-scale))',
                      padding: '3px 10px',
                    }}
                  >
                    {t('common.save')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // ── Render: Right panel (conversation) ──

  const renderConversation = () => {
    return (
      <div
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg)',
        }}
      >
        {/* Chat header */}
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid var(--border-soft)',
            background: 'var(--bg)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600, color: 'var(--fg)' }}>
            {t('taskDetail.conversation')}
          </span>
          <span
            style={{
              fontSize: 'calc(11px * var(--font-scale))',
              fontWeight: 600,
              color: currentStepColor,
              background: `color-mix(in oklab, ${currentStepColor}, transparent 88%)`,
              padding: '2px 8px',
              borderRadius: 4,
            }}
          >
            {currentStep.label}
          </span>
        </div>

        {/* Chat messages */}
        <div
          className="task-chat-history-wrapper"
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            // 待插入消息面板悬浮在输入框上方：由包裹层留出「面板高度 + 2px」
            position: 'relative', paddingBottom: overlayPaddingBottom(1)
          }}
        >
          <div
            className="chat-history-scroll task-chat-history-scroll"
            ref={scrollRef}
            onWheelCapture={(event) => {
              if (shouldPauseConversationFollow({ type: 'wheel', deltaY: event.deltaY })) {
                followRef.current = false
              }
            }}
            onKeyDownCapture={(event) => {
              if (shouldPauseConversationFollow({ type: 'key', key: event.key })) {
                followRef.current = false
              }
            }}
            onScroll={(event) => {
              const container = event.currentTarget
              if (container.scrollTop <= 40) onLoadOlderHistory?.()
              const nearBottom = isNearConversationBottom(
                container.scrollHeight,
                container.scrollTop,
                container.clientHeight,
              )
              const programmaticEcho =
                Math.abs(
                  container.scrollTop -
                    programmaticRef.current,
                ) <= 1
              // 内容变矮（思考块折叠等）时浏览器自动把 scrollTop 钳制到新的底部，
              // 同样触发 scroll 事件；不能把它误判为用户上滚而取消跟随。
              const autoShrinkClamp = isAutoShrinkClamp({
                scrollTop: container.scrollTop,
                prevScrollTop: lastScrollTopRef.current,
                scrollHeight: container.scrollHeight,
                prevScrollHeight: lastScrollHeightRef.current,
                clientHeight: container.clientHeight,
              })
              if (!programmaticEcho) {
                // 用户向上滚动（scrollTop 减小）立即取消跟随，
                // 不能等滚出阈值再取消：流式输出期间内容持续增长，
                // 幅度不够时永远滚不出阈值。
                if (container.scrollTop < lastScrollTopRef.current) {
                  if (autoShrinkClamp) {
                    // 自动钳制落底：同步基准值，后续回显仍按程序滚动识别。
                    programmaticRef.current = container.scrollTop
                  } else if (
                    // 内容变高（展开折叠项 / 思考块等）时浏览器的 scroll anchoring
                    // 可能做微小的向上锚定调整，不应误判为用户主动上滚而取消跟随。
                    // 用户主动滚轮上滚在 capture 步骤已先行取消跟随；此处仅保护
                    // 拖动滚动条等未走 capture 路径时的微小浏览器自动调整。
                    container.scrollHeight > lastScrollHeightRef.current &&
                    lastScrollTopRef.current - container.scrollTop <= 2
                  ) {
                    // 忽略内容变高时的微小锚定调整，保持跟随状态。
                  } else {
                    followRef.current = false
                  }
                }
              }
              // 接近底部时恢复跟随：必须放在 programmaticEcho 判断之外。
              // 展开折叠项导致内容高度变化后，用户向下滚回底部时，scrollTop
              // 可能恰好等于上一次程序钉底的位置（programmaticEcho=true），
              // 若在此分支内判断会被跳过，导致跟随永远无法恢复、自动滚动失效。
              if (container.scrollTop >= lastScrollTopRef.current && nearBottom) {
                if (!followRef.current) {
                  followRef.current = true
                  setUnreadMessages(false)
                }
              }
              setScrolledToBottom(nearBottom)
              lastScrollTopRef.current = container.scrollTop
              lastScrollHeightRef.current = container.scrollHeight
            }}
            style={{
              height: '100%',
              minWidth: 0,
              overflowY: 'auto',
              overflowX: 'hidden',
              paddingBlock: 20,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              ref={contentRef}
              className="chat-history-content"
              style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, minHeight: '100%' }}
            >
            {historyMessages.length === 0 &&
              taskActions.runs.length === 0 &&
              events.length === 0 &&
              !content &&
              liveCoordinatorMessages.length === 0 &&
              !running && (
                <div
                  style={{
                    textAlign: 'center',
                    color: 'var(--meta)',
                    padding: 40,
                    fontSize: 'calc(13px * var(--font-scale))',
                  }}
                >
                  {t('taskDetail.conversationEmpty')}
                </div>
              )}

            {(() => {
              const orderedMessagesRaw = [
                ...historyMessages
                  .filter((message: any) => isVisibleHistoryMessage(message))
                  .map((message: any) =>
                    mergeHistoryMessageWithLive(
                      message,
                      liveMessages[String(message.id)],
                    ),
                  ),
                ...liveExecutionMessages.map((message: any) => ({
                  ...message,
                  run_status: message.status,
                  ended_at:
                    message.status === 'running'
                      ? undefined
                      : lastEventTimestamp(
                            message.events,
                          ),
                })),
              ]
              const orderedMessages = orderConversationMessages(mergeActionMessages(
                orderedMessagesRaw,
                taskActions.runs,
                (message: any) => message.channel === 'action',
                (run, role) => ({
                  id: role === 'user' ? run.user_message_id : run.reply_message_id,
                  channel: 'action', role,
                  content: role === 'user' ? t('actionShortcuts.runTitle', { title: run.title }) : run.output,
                  created_at: run.started_at,
                  started_at: run.started_at,
                  ended_at: role === 'assistant' ? run.ended_at : run.started_at,
                  run_status: role === 'assistant' ? run.status : 'succeeded',
                  reply_to_message_id: role === 'assistant' ? run.user_message_id : undefined,
                }),
              ))
              const latestTaskMessageId = orderConversationMessages([
                ...historyMessages,
                ...Object.values(liveMessages)
                  .filter((item) => isUnpersistedLiveMessage(item, persistedMessageIds))
                  .map((item) => ({ ...item, run_status: item.status })),
              ]).at(-1)?.id
              return orderedMessages.map((message: any) => {
                if (message.channel === 'action') {
                  return <ActionConversationMessage
                    key={message.id}
                    message={message}
                    run={message.actionRun}
                    onStop={canChat ? (runId) => { void taskActions.stop(runId) } : undefined}
                  />
                }
                const stepKey =
                  message.context_step_key ||
                  message.step_key ||
                  'unknown'
                const msgs = [message]
                const stepInfo = steps.find(
                  (s: any) => s.key === stepKey,
                )
                const stepLabel =
                  message.channel === 'coordinator'
                    ? t('aiFlow.agent')
                    : stepInfo?.label || stepKey
                return (
                  <div
                    key={message.id}
                    style={{
                      minWidth: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                    }}
                  >
                    {msgs.map(
                      (msg: any, i: number) => {
                        const isUser =
                          msg.role === 'user'
                        const isSystem =
                          msg.role === 'system'
                        const isReview =
                          msg.channel ===
                            'review' ||
                          msg.role === 'review'
                        const isCoordinator =
                          msg.channel ===
                            'coordinator'
                        const isLiveInsert =
                          !isCoordinator &&
                          msg.role === 'user' &&
                          msg.run_id === msg.id
                        const msgStepIndex =
                          steps.findIndex(
                            (s: any) =>
                              s.key === stepKey,
                          )
                        const msgStepStatus =
                          msgStepIndex >= 0
                            ? stepProgress[
                                msgStepIndex
                              ]?.status
                            : undefined
                        const msgReview =
                          resolveMessageReview(
                            msg,
                            reviews,
                          )
                        const msgReviewPending =
                          isMessageReviewActionable(
                            msg,
                            reviews,
                            msgStepStatus,
                          )
                        const isLastExecutionResponse =
                          !isUser &&
                          !isReview &&
                          !isCoordinator &&
                          !isSystem &&
                          ['succeeded', 'completed'].includes(
                            msg.run_status,
                          ) &&
                          !msgs.slice(i + 1).some(
                            (later) =>
                              later.role === 'assistant' &&
                              later.channel === 'execution',
                          )
                        const isCompletedExecutionResponse =
                          !isUser &&
                          !isReview &&
                          !isCoordinator &&
                          !isSystem &&
                          ['succeeded', 'completed'].includes(msg.run_status)
                        const messageArtifactRound =
                          msg.artifact_round ?? msgReview?.artifact_round
                        const msgArtifacts =
                          isReview || isCompletedExecutionResponse
                            ? messageArtifactRound
                              ? artifactsForMessage(
                                  artifacts,
                                  stepKey,
                                  messageArtifactRound,
                                )
                              : isLastExecutionResponse
                                ? (() => {
                                const stepArtifacts = artifacts.filter(
                                  (artifact) => artifact.step_key === stepKey,
                                )
                                const selected = stepArtifacts.filter(
                                  (artifact) => artifact.is_selected,
                                )
                                const latest = stepArtifacts.filter(
                                  (artifact) => artifact.is_latest,
                                )
                                return selected.length ? selected : latest
                                  })()
                                : []
                            : []
                        const processEvents =
                          Array.isArray(
                            msg.events,
                          )
                            ? msg.events
                            : EMPTY_EVENTS
                        const isManualReview =
                          isReview &&
                          isManualReviewMessage(
                            msg,
                            reviews,
                          )
                        const sender = isUser
                          ? displayUserSender(
                              msg.author_name,
                              localUserName,
                              t('aiFlow.me'),
                            )
                          : isSystem
                            ? t(
                                'taskDetail.system',
                              )
                            : isCoordinator
                              ? t('aiFlow.agent')
                              : isManualReview
                                ? `${stepLabel} · ${t('taskDetail.manualReview')}`
                                : stepLabel
                        const initials =
                          isUser || isSystem
                            ? sender.slice(0, 2)
                            : isCoordinator
                              ? t(
                                  'aiFlow.agentInitials',
                                )
                              : stepAvatarText(
                                  stepLabel,
                                  t,
                                )
                        const senderColor =
                          isUser
                            ? 'var(--accent)'
                            : isSystem
                              ? 'var(--warn)'
                              : isReview
                                ? (stepInfo?.color ||
                                    'var(--warn)')
                                : isCoordinator
                                  ? 'var(--ai-assistant)'
                                  : (stepInfo?.color ||
                                      'var(--fg)')
                        const reviewLine =
                          isManualReview
                            ? t(
                                'taskDetail.manualReview',
                              )
                            : undefined
                        const reviewActor = msgReview
                          ? reviewActorLabel(msgReview)
                          : undefined
                        const messageContent =
                          isReview &&
                          msgReview?.decision
                            ? [
                                reviewLine,
                                msgReview.status ===
                                'passed'
                                  ? t(
                                      'taskDetail.reviewPassed',
                                    )
                                  : msgReview.status ===
                                      'terminated'
                                    ? t(
                                        'taskDetail.reviewTerminated',
                                      )
                                  : t(
                                      'taskDetail.reviewRejected',
                                    ),
                                reviewActor
                                  ? t('taskDetail.reviewedBy', { name: reviewActor })
                                  : undefined,
                                msgReview.decision_comment,
                              ]
                                .filter(
                                  Boolean,
                                )
                                .join('\n')
                            : reviewLine
                              ? `${reviewLine}\n${msg.content || ''}`
                              : msg.content || ''

                        return (
                          <ChatMessageBubble
                            key={i}
                            role={
                              isSystem
                                ? 'system'
                                : isReview
                                  ? 'review'
                                  : isUser
                                    ? 'user'
                                    : 'assistant'
                            }
                            sender={sender}
                            senderTitle={
                              isUser
                                ? displayUserDetail(
                                    msg.author_name,
                                    msg.author_device_name,
                                    t('aiFlow.me'),
                                  )
                                : undefined
                            }
                            initials={initials}
                            color={senderColor}
                            content={messageContent}
                            projectId={projectId}
                            error={resolveMessageError(processEvents) || undefined}
                            errorActions={(() => {
                              const msgError = resolveMessageError(processEvents)
                              if (
                                !onRestartStepWithFreshSession
                                || !isLostEngineSessionError(msgError)
                              ) {
                                return undefined
                              }
                              const restarting = (restartingStepKeys ?? []).includes(stepKey)
                              return (
                                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                                  <span style={{ color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))' }}>
                                    {t('taskDetail.lostSessionHint')}
                                  </span>
                                  <div>
                                    <Button
                                      size="sm"
                                      loading={restarting}
                                      disabled={restarting}
                                      onClick={() => onRestartStepWithFreshSession(stepKey)}
                                    >
                                      {restarting
                                        ? t('taskDetail.lostSessionRestarting')
                                        : t('taskDetail.lostSessionRestart')}
                                    </Button>
                                  </div>
                                </div>
                              )
                            })()}
                            streaming={
                              msg.run_status ===
                              'running'
                            }
                            badge={
                              isReview ? (
                                <span
                                  title="Review"
                                  aria-label={t(
                                    'taskDetail.reviewBadgeAria',
                                  )}
                                >
                                  R
                                </span>
                              ) : undefined
                            }
                            onEdit={
                              canChat && isUser && onPromptChange && onSend
                                ? (content) => {
                                    // Handle edit user message — parent should provide
                                    onPromptChange(content)
                                    chatInputRef?.current?.focus()
                                  }
                                : undefined
                            }
                            onSendToInput={
                              canChat && onPromptChange
                                ? (content) => {
                                    onPromptChange(content)
                                    chatInputRef?.current?.focus()
                                  }
                                : undefined
                            }
                            onA2uiAction={onA2uiAction}
                            events={processEvents}
                            interactionsEnabled={msg.run_status === 'running'}
                            onInteractionRespond={onInteractionRespond}
                            rootProps={{
                              ref:
                                i ===
                                msgs.length - 1
                                  ? (
                                      element,
                                    ) => {
                                      stepLastRef.current[
                                        stepKey
                                      ] = element
                                    }
                                  : undefined,
                              'data-step-last-message':
                                i ===
                                msgs.length - 1
                                  ? stepKey
                                  : undefined,
                            }}
                            header={
                              isUser ? (
                                <>
                                  <span
                                    title={
                                      isCoordinator
                                        ? t(
                                            'taskDetail.sendToCoordinatorTitle',
                                          )
                                        : isLiveInsert
                                          ? t(
                                              'taskDetail.liveInsertTitle',
                                            )
                                          : t(
                                              'taskDetail.stepInitialInputTitle',
                                            )
                                    }
                                    style={{
                                      padding:
                                        '1px 6px',
                                      borderRadius: 999,
                                      fontSize: 'calc(11px * var(--font-scale))',
                                      border:
                                        isLiveInsert
                                          ? 'none'
                                          : '1px solid var(--border-soft)',
                                      background:
                                        isCoordinator
                                          ? 'rgba(124,58,237,0.08)'
                                          : isLiveInsert
                                            ? 'var(--accent)'
                                            : 'rgba(0,113,227,0.08)',
                                      color:
                                        isCoordinator
                                          ? 'var(--ai-assistant)'
                                          : isLiveInsert
                                            ? 'var(--accent-fg)'
                                            : 'var(--accent)',
                                    }}
                                  >
                                    {isCoordinator
                                      ? t(
                                          'taskDetail.coordinatorTag',
                                        )
                                      : `@${stepLabel}`}
                                  </span>
                                  {sender !== t('aiFlow.me') && (
                                    <MarqueeText text={sender} className="user-sender-marquee" />
                                  )}
                                  {formatConversationDateTime(
                                    msg.started_at ||
                                      msg.created_at,
                                    Date.now(),
                                    locale,
                                  )}
                                </>
                              ) : (
                                <MessageMetaBar
                                  createdAt={
                                    msg.created_at
                                  }
                                  startedAt={
                                    msg.started_at
                                  }
                                  running={
                                    msg.run_status ===
                                    'running'
                                  }
                                  events={
                                    processEvents
                                  }
                                  eventSummary={
                                    msg.event_detail
                                  }
                                  eventDetail={
                                    msg.event_detail
                                  }
                                  onLoadEventDetails={
                                    msg.event_detail?.available && onLoadMessageEvents
                                      ? () => onLoadMessageEvents(msg.id)
                                      : undefined
                                  }
                                  pendingInserts={
                                    (stepInserts ?? [])
                                      .length > 0
                                  }
                                  prompt={
                                    msg.prompt ||
                                    livePromptOverrides?.[
                                      String(msg.id)
                                    ]
                                  }
                                  sessionId={
                                    isCoordinator
                                      ? (task
                                          ?.coordinator_session_id ||
                                          null)
                                      : messageSessionId(
                                          msg,
                                          isReview,
                                          sessionIdForStep(stepKey),
                                        )
                                  }
                                  messageId={msg.id}
                                  artifactRound={isCoordinator ? undefined : messageArtifactRound}
                                  onViewPrompt={
                                    onViewingPromptChange
                                  }
                                  status={terminalMessageStatus(
                                    msg.run_status,
                                  )}
                                  onRetryFailedMessage={
                                    onRetryFailedMessage
                                    && canRetryFailedExecutionMessage(
                                      msg,
                                      latestTaskMessageId,
                                      msgStepStatus,
                                      msgStepIndex >= 0 ? stepProgress[msgStepIndex]?.error : undefined,
                                    )
                                      ? () => onRetryFailedMessage(String(msg.id))
                                      : undefined
                                  }
                                  retryingFailedMessage={(retryingFailedMessageIds ?? []).includes(String(msg.id))}
                                  endedAt={
                                    msg.ended_at ||
                                    msgReview?.ended_at
                                  }
                                  reviewMode={
                                    isManualReview
                                  }
                                  reviewStatus={
                                    msgReview?.status
                                  }
                                  onSetReviewComplete={
                                    isReview && onReviewAction
                                    && canCompleteStoppedReview(
                                      msgReview, reviews, artifacts,
                                      task?.status, task?.active_workflow_run_id,
                                      msgStepStatus,
                                    )
                                      ? () => onReviewAction('set-complete', msgReview, stepKey)
                                      : undefined
                                  }
                                  settingReviewComplete={!!reviewActionPending}
                                  projectId={projectId}
                                />
                              )
                            }
                            showLoading={
                              !isUser &&
                              !isCoordinator &&
                              msg.run_status ===
                                'running' &&
                              !msg.content
                            }
                            loading={
                              !isUser &&
                              msg.run_status ===
                                'running'
                                ? (
                                  <StreamingStatusText
                                    label={liveExecutionStatus(
                                      processEvents,
                                      t,
                                      (stepInserts ?? []).length > 0,
                                    )}
                                  />
                                )
                                : undefined
                            }
                            footer={
                              !isUser &&
                              !isSystem &&
                              // 思考中（尚无正文）也展示 Token / t/s / 引擎 * 模型
                              (msg.content ||
                                msg.run_status ===
                                'running') &&
                              !(isReview &&
                                !msg.engine)
                                ? (
                                  <MessageResponseFooter
                                    content={msg.content
                                      ? stripA2uiBlocks(
                                        String(
                                          msg.content,
                                        ),
                                      )
                                      : ''}
                                    usage={
                                      msg.usage ||
                                      usageFromEvents(
                                        processEvents,
                                      )
                                    }
                                    events={processEvents}
                                    engine={
                                      msg.engine
                                    }
                                    model={
                                      msg.model
                                    }
                                    executionModel={
                                      isCoordinator
                                        ? undefined
                                        : executionStepModel
                                    }
                                    startedAt={
                                      msg.started_at ||
                                      msg.created_at
                                    }
                                    endedAt={
                                      msg.ended_at
                                    }
                                    running={
                                      msg.run_status ===
                                      'running'
                                    }
                                    stopped={
                                      !isCoordinator &&
                                      (msg.run_status ===
                                        'cancelled' ||
                                        msg.run_status ===
                                          'stopped')
                                    }
                                    onContinueStep={
                                      canChat &&
                                      !isCoordinator &&
                                      task?.id
                                        ? () => {
                                            // Parent should handle
                                          }
                                        : undefined
                                    }
                                  />
                                )
                                : undefined
                            }
                          >
                            {onProposalOverride && projectId &&
                              (msg.proposals ||
                                [])
                                .map(
                                  (
                                    proposal: ActionProposal,
                                  ) => {
                                    const currentProposal =
                                      (proposalOverrides ??
                                        {})[
                                        proposal.id
                                      ] || proposal
                                    return (
                                      <CoordinatorProposalCard
                                        key={
                                          proposal.id
                                        }
                                        proposal={
                                          currentProposal
                                        }
                                        taskId={
                                          task?.id ||
                                          ''
                                        }
                                        projectId={
                                          projectId ||
                                          ''
                                        }
                                        onChanged={(
                                          updated,
                                        ) =>
                                          onProposalOverride?.(
                                            updated,
                                          )
                                        }
                                      />
                                    )
                                  },
                                )}
                            {!isReview &&
                              renderMessageArtifacts(
                                msgArtifacts,
                                stepInfo?.color,
                              )}
                            {isReview &&
                              msgReviewPending && (
                                <div
                                  style={{
                                    display:
                                      'flex',
                                    flexDirection:
                                      'column',
                                    gap: 8,
                                    marginTop: 2,
                                  }}
                                >
                                  {renderMessageArtifacts(
                                    msgArtifacts,
                                    stepInfo?.color,
                                  )}
                                  {onReviewAction &&
                                    msgReview!.status ===
                                      'pending' && (
                                      <Textarea
                                        rows={2}
                                        value={
                                          reviewComment ??
                                          ''
                                        }
                                        onChange={(
                                          event,
                                        ) =>
                                          onReviewCommentChange?.(
                                            event
                                              .target
                                              .value,
                                          )
                                        }
                                        placeholder={t(
                                          'taskDetail.reviewCommentPlaceholder',
                                        )}
                                      />
                                    )}
                                  {onReviewAction && (
                                    <ReviewDecisionActions
                                      status={msgReview!.status}
                                      pending={!!reviewActionPending}
                                      onAction={(decision) => onReviewAction?.(decision, msgReview!, stepKey)}
                                    />
                                  )}
                                </div>
                              )}
                          </ChatMessageBubble>
                        )
                      },
                    )}
                  </div>
                )
              })
            })()}

            {showCoordinatorThinking && (
              <AssistantThinkingMessage
                sender={t('aiFlow.agent')}
                initials={t('aiFlow.agentInitials')}
                footer={task?.engine || task?.model ? (
                  <MessageResponseFooter
                    content=""
                    engine={task?.engine}
                    model={task?.model}
                    running
                  />
                ) : undefined}
              />
            )}

            {liveCoordinatorMessages.map(
              (message) => {
                const isUser =
                  message.role === 'user'
                const sender = isUser
                  ? displayUserSender(
                      message.author_name,
                      localUserName,
                      t('aiFlow.me'),
                    )
                  : t('aiFlow.agent')
                return (
                  <ChatMessageBubble
                    key={message.id}
                    role={
                      isUser ? 'user' : 'assistant'
                    }
                    sender={sender}
                    senderTitle={
                      isUser
                        ? displayUserDetail(
                            message.author_name,
                            message.author_device_name,
                            t('aiFlow.me'),
                          )
                        : undefined
                    }
                    initials={
                      isUser
                        ? sender.slice(0, 2)
                        : t('aiFlow.agentInitials')
                    }
                    color={
                      isUser
                        ? 'var(--accent)'
                        : 'var(--ai-assistant)'
                    }
                    content={
                      message.content || ''
                    }
                    projectId={projectId}
                    streaming={
                      !isUser &&
                      message.status === 'running'
                    }
                    variant="bg"
                    onA2uiAction={onA2uiAction}
                    events={message.events}
                    interactionsEnabled={
                      !isUser &&
                      message.status === 'running'
                    }
                    onInteractionRespond={onInteractionRespond}
                    header={
                      isUser ? (
                        <>
                          <span>
                            {t(
                              'taskDetail.coordinatorTag',
                            )}
                          </span>
                          {sender !== t('aiFlow.me') && (
                            <MarqueeText text={sender} className="user-sender-marquee" />
                          )}
                          {formatConversationDateTime(
                            message.created_at,
                            Date.now(),
                            locale,
                          )}
                        </>
                      ) : (
                        <MessageMetaBar
                          createdAt={
                            message.created_at
                          }
                          running={
                            message.status ===
                            'running'
                          }
                          events={message.events}
                          prompt={
                            message.prompt ||
                            livePromptOverrides?.[
                              String(message.id)
                            ]
                          }
                          sessionId={
                            task?.coordinator_session_id ||
                            sessionIdForStep(
                              message.step_key,
                            )
                          }
                          messageId={message.id}
                          onViewPrompt={
                            onViewingPromptChange
                          }
                          status={terminalMessageStatus(
                            message.status,
                          )}
                          projectId={projectId}
                        />
                      )
                    }
                    showLoading={
                      !isUser &&
                      !message.content &&
                      message.status === 'running'
                    }
                    loading={
                      <StreamingStatusText label={t('bubble.thinking')} />
                    }
                    footer={
                      !isUser &&
                      (message.content ||
                        message.status ===
                          'running') ? (
                        <MessageResponseFooter
                          content={stripA2uiBlocks(
                            message.content,
                          )}
                          usage={usageFromEvents(
                            message.events,
                          )}
                          events={message.events}
                          engine={
                            message.engine
                          }
                          model={
                            message.model
                          }
                          startedAt={
                            message.created_at
                          }
                          endedAt={
                            message.status ===
                            'running'
                              ? undefined
                              : lastEventTimestamp(
                                  message.events,
                                )
                          }
                          running={
                            message.status ===
                            'running'
                          }
                        />
                      ) : undefined
                    }
                  >
                    {!isUser &&
                      onProposalOverride && projectId &&
                      message.proposals.map(
                        (rawProposal) => {
                          const proposal =
                            rawProposal as unknown as ActionProposal
                          const currentProposal =
                            (proposalOverrides ??
                              {})[
                              proposal.id
                            ] || proposal
                          return (
                            <CoordinatorProposalCard
                              key={
                                proposal.id
                              }
                              proposal={
                                currentProposal
                              }
                              taskId={
                                task?.id ||
                                ''
                              }
                              projectId={
                                projectId ||
                                ''
                              }
                              onChanged={(
                                updated,
                              ) =>
                                onProposalOverride?.(
                                  updated,
                                )
                              }
                            />
                          )
                        },
                      )}
                  </ChatMessageBubble>
                )
              },
            )}

            {/* Legacy execution */}
            {shouldRenderLegacyExecution(
              running ?? false,
              hasProcessEvents(events),
              content,
              hasStructuredExecutionMessage,
            ) && (
              <ChatMessageBubble
                role="assistant"
                sender={activeStep.label}
                initials={stepAvatarText(
                  activeStep.label,
                  t,
                )}
                color={activeStepColor}
                content={content}
                projectId={projectId}
                streaming={running}
                variant="bg"
                onA2uiAction={onA2uiAction}
                events={events}
                interactionsEnabled={Boolean(running)}
                onInteractionRespond={onInteractionRespond}
                header={
                  <ProcessTrace
                    events={events}
                    running={running ?? false}
                    projectId={projectId}
                  />
                }
                showLoading={
                  (running ?? false) &&
                  !content &&
                  !hasProcessEvents(events)
                }
                loading={
                  <StreamingStatusText label={t('chat.processing')} />
                }
                footer={
                  content || running ? (
                    <MessageResponseFooter
                      content={stripA2uiBlocks(
                        content,
                      )}
                      usage={usageFromEvents(
                        events,
                      )}
                      events={events}
                      engine={
                        task?.engine
                      }
                      model={
                        task?.model
                      }
                      executionModel={
                        executionStepModel
                      }
                      endedAt={
                        running
                          ? undefined
                          : lastEventTimestamp(
                              events,
                            )
                      }
                      running={running}
                    />
                  ) : undefined
                }
              />
            )}

            <div ref={endRef} />
            </div>
          </div>

          <ConversationNewMessagesButton
            visible={!scrolledToBottom}
            hasNewMessages={unreadMessages}
            label={t('taskDetail.newMessages')}
            ariaLabel={t('taskDetail.viewNewMessagesAria')}
            onClick={() => {
              followRef.current = true
              setUnreadMessages(false)
              const container = scrollRef.current
              if (container) {
                const target = conversationBottomScrollTop(
                  container.scrollHeight,
                  container.clientHeight,
                )
                programmaticRef.current = target
                container.scrollTo({ top: target, behavior: 'smooth' })
              }
            }}
          />
        </div>

        {/* Chat input (edit mode only) */}
        {canChat && (
          <div
            className="task-detail-composer"
            style={{
              position: 'relative',
              padding: '4px 20px',
              borderTop: '1px solid var(--border-soft)',
              background: 'var(--bg)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              flexShrink: 0,
            }}
          >
            {onSendPrompt && <TaskActionButtons state={taskActions} onFillPrompt={onPromptChange} onSendPrompt={onSendPrompt} />}
            {composerState.running && (
              <ComposerOverlayHostContext.Provider value={registerOverlay}>
              <PendingMessageInserts
                items={stepInserts ?? []}
                title={t('taskDetail.insertMessages')}
                titleTooltip={t('taskDetail.insertMessagesTitle', {
                  step: runningSteps[0]?.label ?? '',
                })}
                editingId={editingInsertId}
                editingContent={editingInsertContent}
                sendingIds={stepInsertSendingIds}
                onEditingContentChange={onEditingInsertContentChange}
                onEditStart={onStepInsertEditStart}
                onEditSave={onStepInsertEditSave}
                onEditCancel={onStepInsertEditCancel}
                onSend={onStepInsertSend}
                onRemove={onStepInsertRemove}
                onSendAll={onSendAllInserts}
                onClear={onClearInserts}
                onReorder={onStepInsertReorder}
                reorderHint={t('taskDetail.insertReorderHint')}
              />
              </ComposerOverlayHostContext.Provider>
            )}
            {/* Chat target tabs */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                width: '100%',
                maxWidth: 900,
                marginInline: 'auto',
              }}
            >
              <div
                className="step-target-tabs"
                style={{
                  display: 'flex',
                  gap: 2,
                  padding: 2,
                  borderRadius: 8,
                  background:
                    'var(--bg-soft, rgba(128,128,128,0.08))',
                  border:
                    '1px solid var(--border-soft)',
                }}
              >
                <button
                  type="button"
                  onClick={() =>
                    onChatTargetChange?.(
                      'coordinator',
                    )
                  }
                  aria-pressed={
                    chatTarget === 'coordinator'
                  }
                  title={t(
                    'taskDetail.coordinatorTabTitle',
                  )}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 6,
                    fontSize: 'calc(11px * var(--font-scale))',
                    fontWeight: 600,
                    border: 'none',
                    cursor: 'pointer',
                    background:
                      chatTarget !==
                        'coordinator'
                        ? 'transparent'
                        : 'var(--accent)',
                    color:
                      chatTarget !==
                        'coordinator'
                        ? 'var(--meta)'
                        : 'var(--accent-fg)',
                  }}
                >
                  {t('aiFlow.agent')}
                </button>
                {targetSteps.map((step) => (
                  <button
                    key={step.key}
                    type="button"
                    onClick={() =>
                      onChatTargetChange?.(
                        step.key,
                      )
                    }
                    aria-pressed={
                      chatTarget === step.key
                    }
                    title={t(
                      runningSteps.some((runningStep) => runningStep.key === step.key)
                        ? 'taskDetail.stepTabTitle'
                        : resumableStatusOf(step.key) === 'pending'
                        ? 'taskDetail.pendingStepTabTitle'
                        : resumableStatusOf(step.key) === 'passed'
                          || resumableStatusOf(step.key) === 'skipped'
                          ? 'taskDetail.stepTabTitle'
                          : resumableStatusOf(step.key) === 'failed'
                            || resumableStatusOf(step.key) === 'rejected'
                            ? 'taskDetail.failedStepTabTitle'
                            : resumableStatusOf(step.key) === 'awaiting_review'
                              ? 'taskDetail.reviewWaitingStepTabTitle'
                              : 'taskDetail.stoppedStepTabTitle',
                      {
                        step: step.label,
                      },
                    )}
                    style={stepTabStyle(
                      step.color || 'var(--accent)',
                      chatTarget === step.key,
                    )}
                  >
                    {step.label}
                  </button>
                ))}
              </div>
              {resumableTarget
                && resumableStatusOf(resumableTarget.key) !== 'passed'
                && resumableStatusOf(resumableTarget.key) !== 'skipped' && (
                <span
                  style={{
                    fontSize: 'calc(11px * var(--font-scale))',
                    color: 'var(--warn)',
                  }}
                >
                  {t(resumableStatusOf(resumableTarget.key) === 'failed'
                    || resumableStatusOf(resumableTarget.key) === 'rejected'
                    ? 'taskDetail.failedStepHint'
                    : resumableStatusOf(resumableTarget.key) === 'awaiting_review'
                      ? 'taskDetail.reviewWaitingStepHint'
                      : resumableStatusOf(resumableTarget.key) === 'pending'
                        ? 'taskDetail.pendingStepHint'
                        : 'taskDetail.stoppedStepHint', {
                    step: resumableTarget.label,
                  })}
                </span>
              )}
              {!resumableTarget &&
                chatTarget !== 'coordinator' &&
                runningSteps.length === 0 && (
                  <span
                    style={{
                      fontSize: 'calc(11px * var(--font-scale))',
                      color: 'var(--warn)',
                    }}
                  >
                    {t(
                      'taskDetail.stepNotRunningHint',
                    )}
                  </span>
                )}
            </div>

            {(chatError || stepEngineConfigError) && (
              <div
                role="alert"
                style={{
                  fontSize: 'calc(13px * var(--font-scale))',
                  color: 'var(--danger)',
                  padding: '6px 10px',
                  borderRadius: 6,
                  border:
                    '1px solid rgba(217,45,32,0.25)',
                  background:
                    'rgba(217,45,32,0.06)',
                }}
              >
                {chatError || stepEngineConfigError}
              </div>
            )}

            <ChatInput
              projectId={projectId}
              taskId={task?.id}
              mentions={{
                options: [
                  {
                    id: 'coordinator',
                    label: t('aiFlow.agent'),
                    color: 'var(--accent)',
                  },
                  ...targetSteps.map((step) => ({
                    id: step.key,
                    label: step.label,
                    color: step.color,
                  })),
                ],
                menuLabel: t('taskDetail.stepMentionMenu'),
                onSelect: (stepKey) => onChatTargetChange?.(stepKey),
              }}
              availableCommands={availableCommands?.[
                chatTarget === 'coordinator'
                  ? 'coordinator:'
                  : `execution:${chatTarget}`
              ]}
              skillEngine={chatTarget === 'coordinator'
                ? coordinatorConfig?.resolved.engine
                : stepEngineConfig?.engine
                  || steps.find((step) => step.key === chatTarget)?.engine
                  || task?.engine
                  || coordinatorConfig?.resolved.engine}
              value={prompt ?? ''}
              onChange={
                (value) => {
                  enhanceInputChanged(value)
                  onPromptChange?.(value)
                }
              }
              onSend={onSend ?? (() => {})}
              enhance={enhance}
              inputRef={chatInputRef}
              imageAttach={
                chatAttachment ?? (projectId
                  ? {
                      projectId,
                      prefix:
                        task?.id?.slice(0, 8) ??
                        '',
                      onError: () => {
                        /* handled by parent */
                      },
                    }
                  : undefined)
              }
              resetStep={(resumableTarget || chatTarget === 'coordinator') && onResetStepChange
                ? {
                    active: Boolean(resetStep),
                    onChange: onResetStepChange,
                    disabled: Boolean(stepResuming || (chatTarget === 'coordinator' && coordinatorRunning)),
                    label: chatTarget === 'coordinator'
                      ? t('chatInput.resetSession')
                      : t('chatInput.resetStep'),
                    title: chatTarget === 'coordinator'
                      ? t('chatInput.resetSessionTitle')
                      : t('chatInput.resetStepTitle'),
                  }
                : undefined}
              stopTitle={
                chatTarget !== 'coordinator'
                  ? t('taskDetail.stopStepTitle')
                  : t('chatInput.stopGenerating')
              }
              config={
                chatTarget !== 'coordinator'
                  ? stepEngineConfig || undefined
                  : {
                  projectId,
                  engines:
                    sharedCoordinatorEngines.length > 0
                      ? sharedCoordinatorEngines
                      : coordinatorConfig
                        ?.available_engines ||
                    [],
                  engine:
                    coordinatorConfig
                      ?.configured.engine || '',
                  providers,
                  providerId:
                    coordinatorConfig
                      ?.configured.provider_id || '',
                  defaultEngine:
                    coordinatorConfig?.resolved
                      .engine ||
                    task?.coordinator_engine ||
                    task?.engine ||
                    'claude',
                  model:
                    coordinatorConfig
                      ?.configured.model || '',
                  fastModel:
                    coordinatorConfig
                      ?.configured.fast_model ||
                    '',
                  visionModel:
                    coordinatorConfig
                      ?.configured.vision_model ||
                    '',
                  thinkingEffort:
                    coordinatorConfig
                      ?.configured
                      .thinking_effort || '',
                  defaultThinkingEffort:
                    coordinatorConfig
                      ?.resolved
                      .thinking_effort || '',
                  showVision: true,
                  disabled:
                    !coordinatorConfig ||
                    (coordinatorRunning ??
                      false),
                  saving:
                    coordinatorConfigSaving,
                  error: coordinatorConfigError,
                  notice:
                    coordinatorConfigNotice,
                  hint: coordinatorConfig
                    ? t(
                        'taskDetail.hintFromNextMessage',
                      )
                    : '',
                  engineTitle: t(
                    'taskDetail.engineTitle',
                  ),
                  onEngineChange:
                    onCoordinatorEngineChange ??
                    (() => {}),
                  onProviderChange:
                    onCoordinatorProviderChange ??
                    (() => {}),
                  onModelChange:
                    onCoordinatorModelChange ??
                    (() => {}),
                  onFastModelChange:
                    onCoordinatorFastModelChange ??
                    (() => {}),
                  onVisionModelChange:
                    onCoordinatorVisionModelChange ??
                    (() => {}),
                  onThinkingEffortChange:
                    onCoordinatorThinkingEffortChange ??
                    (() => {}),
                  onReset: () =>
                    onCoordinatorEngineChange?.(
                      '',
                    ),
                      } as ChatInputEngineConfig
              }
              disabled={composerState.disabled || (
                Boolean(projectId)
                && chatTarget !== 'coordinator'
                && (stepEngineConfigLoading || !stepEngineConfig || Boolean(stepEngineConfig.saving))
              )}
              running={composerState.running}
              allowSendWhileRunning={composerState.running}
              stopping={
                (chatTarget !== 'coordinator' &&
                  (stoppingStepKeys ?? []).includes(chatTarget ?? '')) ||
                (chatTarget === 'coordinator' &&
                  (coordinatorStopping ??
                    false))
              }
              onStop={
                chatTarget !== 'coordinator' && selectedStepRunning
                  ? () =>
                      onStopStep?.(
                        chatTarget ?? '',
                      )
                  : onStop ?? (() => {})
              }
              placeholder={
                resumableTarget
                  ? t('taskDetail.resumeStepPlaceholder', {
                      step: resumableTarget.label,
                    })
                  : chatTarget !== 'coordinator' &&
                      runningSteps[0]
                    ? t('taskDetail.stepPlaceholder', {
                        step: runningSteps[0].label,
                      })
                    : coordinatorRunning
                      ? t(
                          'taskDetail.coordinatorProcessing',
                        )
                      : t(
                          'taskDetail.coordinatorPlaceholder',
                        )
              }
              title={
                resumableTarget
                  ? t('taskDetail.resumeStepTitle', {
                      step: resumableTarget.label,
                    })
                  : chatTarget !== 'coordinator'
                    ? t(
                        'taskDetail.stepInputTitle',
                      )
                    : coordinatorRunning
                      ? t(
                          'taskDetail.stopCoordinatorTitle',
                        )
                      : t(
                          'taskDetail.sendToCoordinator',
                        )
              }
            />
          </div>
        )}
      </div>
    )
  }

  // ── Render: Main layout ──

  if (!task) {
    return (
      <div
        style={{
          padding: 40,
          textAlign: 'center',
          color: 'var(--meta)',
        }}
      >
        {t('taskDetail.taskNotFound')}
        {onClose && (
          <>
            <br />
            <Button
              variant="ghost"
              style={{ marginTop: 12 }}
              onClick={onClose}
            >
              ← {t('common.back')}
            </Button>
          </>
        )}
      </div>
    )
  }

  return (
    <>
      {/* Header */}
      {renderHeader()}

      {(!compact || canShowAnalysis || gitEnabled) && (
        <div className="task-detail-primary-tabs" role="tablist" aria-label={t('executionAnalysis.title')}>
          <button type="button" role="tab" aria-selected={detailMode === 'detail'} onClick={() => setDetailMode('detail')}>{t('taskDetail.detailTab')}</button>
          {!compact && (
            <button type="button" role="tab" aria-selected={detailMode === 'artifacts'} onClick={() => setDetailMode('artifacts')}>{t('mobile.artifacts')}</button>
          )}
          {canShowAnalysis && (
            <button type="button" role="tab" aria-selected={detailMode === 'analysis'} onClick={() => setDetailMode('analysis')}>{t('executionAnalysis.title')}</button>
          )}
          {gitEnabled && (gitProjectId || projectId) && (
            <button type="button" role="tab" aria-selected={detailMode === 'git'} onClick={() => setDetailMode('git')}>{t('git.taskWorkspace')}</button>
          )}
        </div>
      )}

      {detailMode === 'git' && gitEnabled && (gitProjectId || projectId) ? (
        <TaskGitWorkspace projectId={(gitProjectId || projectId)!} taskId={task.id} />
      ) : detailMode === 'analysis' && canShowAnalysis ? (
        <TaskExecutionAnalysis
          taskId={task.id}
          projectId={projectId}
          loadReport={executionReportLoader}
        />
      ) : detailMode === 'artifacts' && !compact ? (
        renderArtifactPanel()
      ) : <>
      {compact && <div className="mobile-detail-tabs" role="tablist">
        {(['conversation', 'steps', 'artifacts'] as const).map(tab => <button key={tab} role="tab" aria-selected={mobileTab === tab} onClick={() => setMobileTab(tab)}>{t(`mobile.${tab}`)}</button>)}
      </div>}
      {compact && actionablePendingReview && <button className="mobile-review-entry" onClick={() => {
        const index = steps.findIndex(step => step.key === actionablePendingReview.step_key)
        if (index >= 0) onStepClick(index)
        setMobileTab('steps')
        requestAnimationFrame(() => mobileReviewRef.current?.scrollIntoView({ block: 'center' }))
      }}><Icon name="shield" size={18} />{t('status.awaiting_review')}<Icon name="chevron-right" size={16} /></button>}
      {/* Content split */}
      <div
        className="task-detail-content" data-mobile-tab={mobileTab}
        ref={contentSplitRef}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: `${splitRatio}fr ${SPLIT_HANDLE_WIDTH}px ${1 - splitRatio}fr`,
        }}
      >
        {/* Left panel */}
        <div className="task-detail-steps">{renderLeftPanel()}</div>

        {/* Split handle */}
        <div
          style={{
            background: 'var(--border-soft)',
            cursor: 'col-resize',
            position: 'relative',
            width: "2px",
          }}
          onPointerDown={beginSplitResize}
        >
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              color: 'var(--meta)',
              fontSize: 'calc(11px * var(--font-scale))',
              opacity: 0.5,
            }}
          >
            ⋮
          </span>
        </div>

        {/* Right panel (conversation) */}
        <div className="task-detail-conversation">{renderConversation()}</div>
        {compact && renderArtifactPanel()}
      </div>
      </>}
    </>
  )
}

// ─── CoordinatorProposalCard (inline) ────────────────────────────────────

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
  const injectedPrompt = typeof current.payload.content === 'string'
    ? current.payload.content.trim()
    : ''
  const actionScript = current.type === 'create_workflow_action' && typeof current.payload.script_content === 'string'
    ? current.payload.script_content
    : ''
  const actionPath = actionScript
    ? `.workstep/artifacts/${current.payload.workflow_id}/actions/${current.payload.action_id}/${current.payload.script_path}`
    : ''
  const retryable =
    current.status === 'failed' && current.type === 'rerun_from_step'
  const canAct = (current.status === 'pending' || retryable) && !pending

  const confirm = async () => {
    setPending(true)
    setError('')
    try {
      // Import taskApi dynamically to avoid circular dependency
      const { taskApi } = await import('../api/client')
      onChanged(
        await taskApi.confirmAction(
          taskId,
          current.id,
          projectId,
          randomUuid(),
        ),
      )
    } catch (reason) {
      const fallbackError =
        reason instanceof Error
          ? reason.message
          : t('taskDetail.proposalConfirmFailed')
      try {
        const { taskApi } = await import('../api/client')
        const history = await taskApi.history(taskId, projectId)
        const latest = [...history.messages]
          .reverse()
          .flatMap((message) => message.proposals || [])
          .find((item) => item.id === current.id) as
          | ActionProposal
          | undefined
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
      const { taskApi } = await import('../api/client')
      onChanged(await taskApi.cancelAction(taskId, current.id, projectId))
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('taskDetail.proposalCancelFailed'),
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 12,
        background: 'var(--bg)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 700 }}>
        {current.type === 'create_workflow_action'
          ? t('taskDetail.proposalCreateActionTitle')
          : t('taskDetail.proposalTitle', { type: current.type })}
      </div>
      <div style={{ fontSize: 'calc(13px * var(--font-scale))', color: 'var(--muted)' }}>
        {current.impact?.summary ||
          t('taskDetail.proposalTargetStep', {
            step: current.target_step_key || t('common.none'),
          })}
      </div>
      {actionScript && (
        <div style={{ border: '1px solid var(--border-soft)', borderRadius: 6, padding: 10, background: 'var(--surface)' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{String(current.payload.label)} · {actionPath}</div>
          <div style={{ color: 'var(--meta)', marginBottom: 6 }}>
            {t('taskDetail.proposalActionCwd', { directory: String(current.payload.cwd_mode) })} · {t('taskDetail.proposalActionConfirmation', { value: t(current.payload.require_confirmation === false ? 'taskDetail.proposalActionNo' : 'taskDetail.proposalActionYes') })}
          </div>
          <pre style={{ maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{actionScript}</pre>
        </div>
      )}
      {injectedPrompt && (
        <div
          style={{
            padding: '8px 10px',
            borderRadius: 6,
            border: '1px solid var(--border-soft)',
            background: 'var(--surface)',
          }}
        >
          <div
            style={{
              marginBottom: 4,
              color: 'var(--meta)',
              fontSize: 'calc(11px * var(--font-scale))',
              fontWeight: 600,
            }}
          >
            {t('taskDetail.proposalInjectedPrompt')}
          </div>
          <div
            style={{
              color: 'var(--text)',
              fontSize: 'calc(12px * var(--font-scale))',
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {injectedPrompt}
          </div>
        </div>
      )}
      <div
        style={{
          fontSize: 'calc(11px * var(--font-scale))',
          color:
            current.status === 'failed' ? 'var(--danger)' : 'var(--meta)',
        }}
      >
        {t('taskDetail.proposalStatus', { status: current.status })}
        {current.error ? ` · ${current.error}` : ''}
      </div>
      {error && (
        <div style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--danger)' }}>{error}</div>
      )}
      {(current.status === 'pending' || retryable) && (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            variant="primary"
            disabled={!canAct}
            loading={pending}
            onClick={() => void confirm()}
          >
            {retryable ? t('common.retry') : t('common.confirm')}
          </Button>
          {current.status === 'pending' && (
            <Button
              variant="ghost"
              disabled={!canAct}
              onClick={() => void cancel()}
            >
              {t('common.cancel')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
