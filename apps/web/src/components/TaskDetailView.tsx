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
import { usePromptEnhance } from '../hooks/usePromptEnhance'
import {
  type ActionProposal,
  type CoordinatorConfig,
  type EngineInputItem,
  type ProviderInfo,
  type ReviewRun,
  type TaskArtifact,
  type TaskStepState,
} from '../api/client'
import Button from './Button'
import Input from './Input'
import Textarea from './Textarea'
import ChatMessageBubble from './ChatMessageBubble'
import AssistantThinkingMessage from './AssistantThinkingMessage'
import StreamingStatusText from './StreamingStatusText'
import ConversationNewMessagesButton from './ConversationNewMessagesButton'
import ChatInput, { type ChatInputEngineConfig } from './ChatInput'
import MessageMetaBar from './MessageMetaBar'
import MessageResponseFooter, {
  usageFromEvents,
} from './MessageResponseFooter'
import { stripA2uiBlocks } from '../utils/a2ui'
import MarkdownEditor from './MarkdownEditor'
import MarkdownMessage from './MarkdownMessage'
import ProcessTrace from './ProcessTrace'
import Icon from './Icon'
import PendingMessageInserts from './PendingMessageInserts'
import {
  isVisibleHistoryMessage,
  isVisibleLiveExecutionMessage,
  isUnpersistedLiveMessage,
  isManualReviewMessage,
  isMessageReviewActionable,
  isStageResumableWithMessage,
  isNearConversationBottom,
  shouldPauseConversationFollow,
  conversationBottomScrollTop,
  isAutoShrinkClamp,
  liveExecutionStatus,
  mergeHistoryMessageWithLive,
  observeContentResize,
  orderConversationMessages,
  resolveTaskComposerState,
  resolveMessageReview,
  shouldRenderLegacyExecution,
  stageAvatarText,
} from '../pages/taskDetailChat'
import {
  formatConversationDateTime,
  formatDurationBetween,
  toMilliseconds,
} from '../utils/datetime'
import { useI18n, type TKey } from '../i18n'
import { shouldShowAssistantThinking } from '../utils/assistantThinking'

// ─── Types ───────────────────────────────────────────────────────────────

export type StageVisualState =
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

export interface StageData {
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

export interface StageProgress extends Partial<TaskStepState> {
  visualState: StageVisualState
}

const PROCESS_EVENT_TYPES = new Set([
  'thinking_delta',
  'tool_use',
  'tool_input_delta',
  'tool_result',
])

const STATUS_LABEL_KEYS: Record<string, TKey> = {
  ready: 'status.ready',
  running: 'status.running',
  paused: 'status.paused',
  stopped: 'status.stopped',
  done: 'status.done',
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
  /** Hides all editing controls — suitable for the shared read-only view. */
  readOnly?: boolean

  // ── Task data ──
  task: {
    id: string
    title: string
    description?: string | null
    status: string
    steps: TaskStepState[]
    created_at: string
    updated_at?: string
    run_round?: number
    engine?: string
    model?: string | null
    restart_from_step_key?: string | null
    coordinator_engine?: string | null
    coordinator_session_id?: string | null
    review_overrides?: Record<string, any> | null
    recovered_count?: number
  } | null | undefined

  // ── Stage definitions & progress ──
  stages: StageData[]
  stageProgress: StageProgress[]
  selectedStage: number
  onStageClick: (index: number) => void

  // ── Messages ──
  historyMessages: any[]
  onLoadMessageEvents?: (messageId: string) => void
  liveMessages: Record<string, LiveMessage>
  events: any[]
  content: string
  availableCommands?: Record<string, EngineInputItem[]>

  // ── Reviews ──
  reviews: ReviewRun[]
  reviewActionPending?: boolean
  reviewComment?: string
  onReviewCommentChange?: (value: string) => void
  onReviewAction?: (
    action: 'approve' | 'reject' | 'force-approve',
    review?: any,
    stepKey?: string,
  ) => void

  // ── Artifacts ──
  artifacts: TaskArtifact[]
  onOpenArtifact: (name: string, stepKey?: string) => void

  // ── Chat (edit mode only) ──
  chatTarget?: string | 'coordinator'
  onChatTargetChange?: (target: string | 'coordinator') => void
  coordinatorRunning?: boolean
  coordinatorConfig?: CoordinatorConfig | null
  chatError?: string
  onChatError?: (message: string) => void
  prompt?: string
  onPromptChange?: (value: string) => void
  onSend?: () => void
  onStop?: () => void
  stoppingStepKeys?: string[]
  stageResuming?: boolean
  onStopStage?: (stepKey: string) => void
  chatInputRef?: React.RefObject<HTMLTextAreaElement | null>

  // ── Stage inserts (edit mode only) ──
  stageInserts?: Array<{ id: string; content: string }>
  onStageInsertRemove?: (id: string) => void
  onStageInsertSend?: (insert: { id: string; content: string }) => void
  onStageInsertEditStart?: (insert: { id: string; content: string }) => void
  onStageInsertEditSave?: (id: string) => void
  onStageInsertEditCancel?: () => void
  editingInsertId?: string | null
  editingInsertContent?: string
  onEditingInsertContentChange?: (value: string) => void
  onSendAllInserts?: () => void
  onClearInserts?: () => void

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
  stageLastMessageRefs?: React.MutableRefObject<
    Record<string, HTMLDivElement | null>
  >
  pendingStageScrollRef?: React.MutableRefObject<string | null>
  hasUnreadMessages?: boolean
  onUnreadMessagesChange?: (hasUnreadMessages: boolean) => void

  // ── Derived helpers ──
  locale: string
  durationNowMs: number
  currentStage: StageData
  activeStage: StageData
  currentStageColor: string
  activeStageColor: string
  taskCompleted: boolean
  runningStages: StageData[]
  executionStageModel: string
  sessionIdForStep: (stepKey?: string | null) => string | null
  onViewingPromptChange: (value: string | null) => void
  running?: boolean

  // ── Project ──
  projectId?: string
}

// ─── Component ───────────────────────────────────────────────────────────

export default function TaskDetailView({
  readOnly,
  task,
  stages,
  stageProgress,
  selectedStage,
  onStageClick,
  historyMessages,
  onLoadMessageEvents,
  liveMessages,
  events,
  content,
  availableCommands,
  reviews,
  reviewActionPending,
  reviewComment,
  onReviewCommentChange,
  onReviewAction,
  artifacts,
  onOpenArtifact,
  // Chat
  chatTarget,
  onChatTargetChange,
  coordinatorRunning,
  coordinatorConfig,
  chatError,
  prompt,
  onPromptChange,
  onSend,
  onStop,
  stoppingStepKeys,
  stageResuming,
  onStopStage,
  chatInputRef,
  // Stage inserts
  stageInserts,
  onStageInsertRemove,
  onStageInsertSend,
  onStageInsertEditStart,
  onStageInsertEditSave,
  onStageInsertEditCancel,
  editingInsertId,
  editingInsertContent,
  onEditingInsertContentChange,
  onSendAllInserts,
  onClearInserts,
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
  stageLastMessageRefs,
  pendingStageScrollRef,
  hasUnreadMessages,
  onUnreadMessagesChange,
  // Derived
  locale,
  durationNowMs,
  currentStage,
  currentStageColor,
  activeStage,
  activeStageColor,
  taskCompleted,
  runningStages,
  executionStageModel,
  sessionIdForStep,
  onViewingPromptChange,
  running,
  projectId,
  onChatError,
}: TaskDetailViewProps) {
  const { t } = useI18n()
  const localDeviceId = useUserSettingsStore((state) => state.deviceId)
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

  // 未在运行的阶段（等待审核 / 手动停止 / 失败 / 审核驳回）仍保留在「发给谁」选择中，
  // 选中后输入消息可带提示重新执行该阶段。
  const resumableStages = stages.filter((stage) => (
    stageProgress.some((progress) => (
      progress.step_key === stage.key
      && isStageResumableWithMessage(progress.status)
    ))
  ))
  const resumableStatusOf = (stageKey: string): string | null => {
    const progress = stageProgress.find((item) => item.step_key === stageKey)
    const status = progress?.status
    return isStageResumableWithMessage(status)
      ? (status ?? null)
      : null
  }
  const resumableTarget = chatTarget !== 'coordinator'
    ? resumableStages.find((stage) => stage.key === chatTarget) ?? null
    : null
  const composerState = resolveTaskComposerState({
    target: chatTarget === 'coordinator' ? 'coordinator' : 'stage',
    stageRunning: runningStages.length > 0,
    stageResuming: Boolean(resumableTarget && stageResuming),
    coordinatorRunning: coordinatorRunning ?? false,
    prompt: prompt ?? '',
  })

  // 「发给谁」阶段 tab 样式：背景色与对应阶段颜色一致（选中加深并加描边）。
  const stageTabStyle = (stageColor: string, selected: boolean) => ({
    padding: '4px 10px',
    borderRadius: 6,
    fontSize: 'calc(11px * var(--font-scale))',
    fontWeight: 600,
    border: selected ? `1px solid ${stageColor}` : '1px solid transparent',
    cursor: 'pointer',
    background: `color-mix(in oklab, ${stageColor}, transparent ${selected ? 82 : 93}%)`,
    color: stageColor,
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
  const localStageLastMessageRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const localPendingStageScrollRef = useRef<string | null>(null)
  const [localHasUnread, setLocalHasUnread] = useState(false)

  // ── Split ratio (draggable divider between left panel & conversation) ──
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
      document.body.style.userSelect = 'none'

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
  const stageLastRef = stageLastMessageRefs ?? localStageLastMessageRefs
  const pendingScrollRef = pendingStageScrollRef ?? localPendingStageScrollRef
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
    if (followRef.current) {
      if (container) {
        const target = conversationBottomScrollTop(
          container.scrollHeight,
          container.clientHeight,
        )
        programmaticRef.current = target
        lastScrollHeightRef.current = container.scrollHeight
        container.scrollTop = target
      }
      setUnreadMessages(false)
    } else {
      if (container) lastScrollHeightRef.current = container.scrollHeight
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

  const visibleStages = useMemo(() => {
    const hideSkipped = (task?.run_round ?? 1) > 1
    const entries = stages.map((stage, index) => ({ stage, index }))
    if (!hideSkipped) return entries
    return entries.filter(
      ({ index }) => stageProgress[index]?.visualState !== 'skipped',
    )
  }, [stages, stageProgress, task?.run_round])

  const selectedReview = reviews.find(
    (review) => review.step_key === currentStage.key,
  )

  const findArtifact = (
    name: string,
    preferredStepKey?: string,
    source?: TaskArtifact[],
  ) => {
    const normalize = (value: string) =>
      value.toLocaleLowerCase().replace(/[\s_.-]/g, '')
    const normalizedName = normalize(name)
    const list = source || artifacts
    const candidates = preferredStepKey
      ? list.filter((artifact) => artifact.step_key === preferredStepKey)
      : list
    return (
      candidates.find((artifact) => artifact.logical_name === name) ||
      candidates.find((artifact) => {
        const artifactName = normalize(
          artifact.logical_name || artifact.name,
        )
        return (
          artifactName.includes(normalizedName) ||
          normalizedName.includes(artifactName)
        )
      })
    )
  }

  const handleStageClick = (stageIndex: number) => {
    onStageClick(stageIndex)
    const stageKey = stages[stageIndex]?.key
    if (!stageKey) return
    pendingScrollRef.current = stageKey
    requestAnimationFrame(() => {
      stageLastRef.current[stageKey]?.scrollIntoView({
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
          ...(draggable ? { cursor: 'move', userSelect: 'none' } : {}),
        }}
      >
        {draggable && (
          <span
            aria-hidden="true"
            style={{ cursor: 'move', userSelect: 'none', lineHeight: 1 }}
          >
            ⠿
          </span>
        )}
        {!readOnly && onClose && (
          <Button variant="icon" onClick={onClose}>
            ←
          </Button>
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
            <span style={{ fontSize: 'calc(20px * var(--font-scale))', fontWeight: 600, lineHeight: 1.4 }}>
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
                background: `color-mix(in oklab, ${activeStageColor}, transparent 85%)`,
                color: activeStageColor,
              }}
            >
              {t('taskDetail.currentStage', { stage: activeStage.label })}
            </span>
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
      </div>
    )
  }

  // ── Render: Recovered hint ──

  const renderRecoveredHint = () => {
    if (
      readOnly ||
      task?.status !== 'running' ||
      !(task?.recovered_count || 0)
    )
      return null
    return (
      <div
        role="status"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 16px',
          fontSize: 'calc(13px * var(--font-scale))',
          lineHeight: 1.4,
          color: 'var(--accent)',
          background: 'color-mix(in oklab, var(--accent), transparent 92%)',
          borderBottom: '1px solid var(--border-soft)',
          flexShrink: 0,
        }}
      >
        <span className="task-status-spinner" aria-hidden="true" />
        <span>
          {t('taskDetail.recoveredRunning', {
            count:
              task.recovered_count && task.recovered_count > 1
                ? t('taskDetail.recoveredCount', {
                    count: task.recovered_count,
                  })
                : '',
          })}
        </span>
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
            {!readOnly && !editingDescription && (
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

        {/* Progress timeline */}
        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 14,
            }}
          >
            <div
              style={{
                fontSize: 'calc(11px * var(--font-scale))',
                fontWeight: 700,
                color: 'var(--muted)',
                fontFamily: 'var(--font-mono)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              {t('taskDetail.progress')}
            </div>
            {(task?.run_round ?? 1) > 1 && (
              <span
                style={{
                  fontSize: 'calc(11px * var(--font-scale))',
                  fontWeight: 600,
                  padding: '3px 8px',
                  borderRadius: 999,
                  color: 'var(--fg-2)',
                  background:
                    'color-mix(in oklab, var(--accent), transparent 90%)',
                }}
              >
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
                'current',
                'reviewing',
                'awaiting_review',
                'retrying',
                'rework',
                'rework_waiting',
              ].includes(visualState)
              const isFailed = visualState === 'failed'
              const isCancelled = visualState === 'cancelled'
              const isSkipped = visualState === 'skipped'
              const isSelected = i === selectedStage
              const stageColor = stage.color || 'var(--accent)'
              const currentRound = task?.run_round ?? 1
              const restartIndex = stages.findIndex(
                (item: any) => item.key === task?.restart_from_step_key,
              )
              const stageRound =
                restartIndex >= 0 && i < restartIndex
                  ? Math.max(1, currentRound - 1)
                  : currentRound
              const stageRoundColor = 'var(--accent)'
              const finishedDuration = progress?.ended_at
                ? formatDurationBetween(
                    progress?.started_at,
                    progress.ended_at,
                    t,
                  )
                : null
              const startedAtMs =
                toMilliseconds(progress?.started_at) ??
                toMilliseconds(task.created_at) ??
                Date.now()
              const updatedAtMs =
                toMilliseconds(task.updated_at) ?? Date.now()
              const isDurationLive =
                task.status === 'running' ||
                [
                  'reviewing',
                  'awaiting_review',
                  'retrying',
                  'rework',
                  'rework_waiting',
                ].includes(visualState)
              const activeDuration =
                isCurrentActive && progress?.started_at
                  ? formatDurationBetween(
                      progress.started_at,
                      isDurationLive ? durationNowMs : updatedAtMs,
                      t,
                    )
                  : null
              const activeStateColor =
                task.status === 'paused'
                  ? 'var(--status-paused)'
                  : task.status === 'stopped'
                    ? 'var(--status-stopped)'
                    : visualState === 'reviewing'
                      ? 'var(--accent)'
                      : ['retrying', 'rework', 'rework_waiting'].includes(
                            visualState,
                          )
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
              const stageLabelColor = visualState === 'pending'
                ? 'color-mix(in oklab, var(--meta), var(--bg) 25%)'
                : isSkipped
                  ? 'var(--meta)'
                  : 'var(--fg-2)'
              return (
                <div
                  key={stage.key}
                  role="button"
                  tabIndex={0}
                  aria-label={t('taskDetail.viewStageMessagesAria', {
                    stage: stage.label,
                  })}
                  onClick={() => handleStageClick(i)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      handleStageClick(i)
                    }
                  }}
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    position: 'relative',
                    paddingTop: 24,
                    cursor: 'pointer',
                    outline: 'none',
                  }}
                >
                  {/* Connector line */}
                  <div
                    style={{
                      position: 'absolute',
                      // Align the connector with the vertical center of the
                      // stage dot (paddingTop 24 + dotSize 20 / 2 - 1).
                      top: 33,
                      left: pos === 0 ? '50%' : 0,
                      right:
                        pos === visibleStages.length - 1 ? '50%' : 0,
                      height: 2,
                      background: stateColor,
                    }}
                  />
                  {/* Dot */}
                  <div
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: '50%',
                      background:
                        isCompleted ||
                        isCurrentActive ||
                        isFailed ||
                        isCancelled ||
                        isSkipped
                          ? stageColor
                          : 'var(--bg)',
                      border: `2px solid ${stageColor}`,
                      position: 'relative',
                      zIndex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--accent-fg)',
                      fontSize: 'calc(13px * var(--font-scale))',
                      fontWeight: 700,
                      boxShadow: isSelected
                        ? `0 0 0 4px color-mix(in oklab, ${stageColor}, transparent 72%)`
                        : 'none',
                    }}
                  >
                    {isCompleted
                      ? '✓'
                      : isCurrentActive
                        ? task.status === 'paused'
                          ? '–'
                          : <span className="task-status-spinner" />
                        : isFailed
                          ? '×'
                          : isCancelled
                            ? '▮'
                            : isSkipped
                              ? '–'
                              : ''}
                  </div>
                  {visualState !== 'pending' && (
                    <span
                      style={{
                        position: 'absolute',
                        top: 5,
                        left: '50%',
                        transform: 'translateX(-50%)',
                        fontSize: 'calc(11px * var(--font-scale))',
                        padding: '2px 6px',
                        borderRadius: 999,
                        color: stateColor,
                        background: `color-mix(in oklab, ${stateColor}, transparent 88%)`,
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                        zIndex: 1,
                      }}
                    >
                      {t(STAGE_STATE_LABEL_KEYS[visualState])}
                    </span>
                  )}
                  <div
                    style={{
                      height: 28,
                      marginTop: 8,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 'calc(13px * var(--font-scale))',
                        textAlign: 'center',
                        whiteSpace: 'nowrap',
                        color: stageLabelColor,
                        fontWeight: isSelected
                          ? 750
                          : isCurrentActive
                            ? 650
                            : 500,
                        padding: '3px 8px',
                        borderRadius: 6,
                        border: isSelected
                          ? `1px solid ${stageColor}`
                          : '1px solid transparent',
                        background: 'transparent',
                      }}
                    >
                      {stage.label}
                    </span>
                  </div>
                  <div
                    style={{
                      height: 20,
                      marginTop: 2,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {currentRound > 1 && (
                      <span
                        style={{
                          fontSize: 'calc(11px * var(--font-scale))',
                          padding: '2px 6px',
                          borderRadius: 999,
                          background: `color-mix(in oklab, ${stageRoundColor}, transparent 88%)`,
                          fontWeight: 600,
                        }}
                      >
                        {t('taskDetail.runRoundShort', {
                          round: stageRound,
                        })}
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      minHeight: 32,
                      marginTop: 2,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 2,
                    }}
                  >
                    {finishedDuration && (
                      <div
                        style={{
                          fontSize: 'calc(11px * var(--font-scale))',
                          color: 'var(--meta)',
                          textAlign: 'center',
                          lineHeight: 1.5,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {t('taskDetail.duration', {
                          duration: finishedDuration,
                        })}
                      </div>
                    )}
                    {isCurrentActive && (
                      <div
                        style={{
                          fontSize: 'calc(11px * var(--font-scale))',
                          color: 'var(--meta)',
                          textAlign: 'center',
                          lineHeight: 1.5,
                        }}
                      >
                        <div>
                          {t('taskDetail.startedAt', {
                            time: new Date(startedAtMs).toLocaleTimeString(
                              locale,
                              {
                                hour: '2-digit',
                                minute: '2-digit',
                              },
                            ),
                          })}
                        </div>
                        {activeDuration && (
                          <span
                            style={{
                              color: 'var(--fg-2)',
                              fontWeight: 500,
                            }}
                          >
                            {t('taskDetail.duration', {
                              duration: activeDuration,
                            })}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Stage prompt */}
        {!readOnly && (
          <div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                color: `${currentStageColor}`,
              }}
            >
              {' '}
              {currentStage.label}{' '}
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
                {t('taskDetail.stagePrompt')}
              </div>
              <Button
                variant="ghost"
                onClick={onOpenPromptEditor}
                style={{ height: 28, padding: '0 9px', fontSize: 'calc(13px * var(--font-scale))', gap: 4 }}
              >
                <span aria-hidden="true">✎</span>
                {t('taskDetail.quickEdit')}
              </Button>
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
              {currentStage.prompt ? (
                <MarkdownMessage
                  content={currentStage.prompt}
                  projectId={projectId}
                />
              ) : (
                <div style={{ fontSize: 'calc(13px * var(--font-scale))', color: 'var(--meta)' }}>
                  {t('taskDetail.noStagePrompt')}
                </div>
              )}
            </div>
          </div>
        )}

        {/* I/O section */}
        <div>
          <div
            style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600, marginBottom: 8 }}
          >
            {t('taskDetail.stageIo')}
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
                const isStageDone =
                  stageProgress[selectedStage]?.visualState === 'completed'
                const nextStageIdx = selectedStage + 1
                const nextStage =
                  nextStageIdx < stages.length
                    ? stages[nextStageIdx]
                    : null
                const nextInputs = nextStage
                  ? nextStage.inputs || []
                  : []
                const stageOutputs =
                  currentStage.outputs ||
                  (currentStage.inputs || [])[0]?.outputs ||
                  []

                return (currentStage.inputs || []).map(
                  (inp: any, inpIdx: number) => {
                    const subOutputs =
                      inpIdx === 0 ? stageOutputs : []
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
                          role="button"
                          tabIndex={0}
                          aria-label={t('taskDetail.openInputAria', {
                            name: inp.name,
                          })}
                          onClick={() => onOpenArtifact(inp.name)}
                          onKeyDown={(event) => {
                            if (
                              event.key === 'Enter' ||
                              event.key === ' '
                            ) {
                              event.preventDefault()
                              onOpenArtifact(inp.name)
                            }
                          }}
                          title={t('taskDetail.openFileTitle', {
                            name: inp.name,
                          })}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '8px 10px',
                            background: 'var(--surface)',
                            borderRadius: 6,
                            border: '1px solid var(--border-soft)',
                            cursor: 'pointer',
                          }}
                        >
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
                              fontSize: 'calc(13px * var(--font-scale))',
                              fontWeight: 500,
                              flex: 1,
                            }}
                          >
                            {inp.name}
                          </span>
                          <span
                            style={{
                              fontSize: 'calc(11px * var(--font-scale))',
                              color: 'var(--accent)',
                            }}
                          >
                            {t('taskDetail.view')}
                          </span>
                          <span
                            style={{
                              fontSize: 'calc(11px * var(--font-scale))',
                              color: 'var(--meta)',
                              background: 'var(--surface)',
                              border: '1px solid var(--border-soft)',
                              padding: '0 4px',
                              borderRadius: 3,
                            }}
                          >
                            {inp.type}
                          </span>
                        </div>
                        {/* Sub-outputs */}
                        {subOutputs.map(
                          (out: any, outIdx: number) => {
                            const nextInput = nextInputs[outIdx]
                            const statusDone = isStageDone
                            const outArtifact = findArtifact(
                              out.name,
                              currentStage.key,
                            )
                            return (
                              <div
                                key={outIdx}
                                role="button"
                                tabIndex={0}
                                aria-label={t(
                                  'taskDetail.openOutputAria',
                                  { name: out.name },
                                )}
                                onClick={() =>
                                  onOpenArtifact(
                                    out.name,
                                    currentStage.key,
                                  )
                                }
                                onKeyDown={(event) => {
                                  if (
                                    event.key === 'Enter' ||
                                    event.key === ' '
                                  ) {
                                    event.preventDefault()
                                    onOpenArtifact(
                                      out.name,
                                      currentStage.key,
                                    )
                                  }
                                }}
                                title={t('taskDetail.openFileTitle', {
                                  name: out.name,
                                })}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  marginLeft: 18,
                                  padding: '4px 8px',
                                  cursor: 'pointer',
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
                                      background: 'var(--success)',
                                      flexShrink: 0,
                                    }}
                                  />
                                )}
                                <span
                                  style={{
                                    fontSize: 'calc(13px * var(--font-scale))',
                                    flex: 1,
                                  }}
                                >
                                  {out.name}
                                </span>
                                <span
                                  style={{
                                    fontSize: 'calc(11px * var(--font-scale))',
                                    color: 'var(--accent)',
                                  }}
                                >
                                  {t('common.open')}
                                </span>
                                <span
                                  style={{
                                    fontSize: 'calc(11px * var(--font-scale))',
                                    color: 'var(--meta)',
                                    background: 'var(--surface)',
                                    border: '1px solid var(--border-soft)',
                                    padding: '0 3px',
                                    borderRadius: 2,
                                  }}
                                >
                                  {out.type}
                                </span>
                                <span
                                  style={{
                                    fontSize: 'calc(11px * var(--font-scale))',
                                    fontWeight: 500,
                                    padding: '1px 5px',
                                    borderRadius: 3,
                                    background: statusDone
                                      ? 'color-mix(in oklab, var(--success), transparent 85%)'
                                      : 'var(--surface)',
                                    color: statusDone
                                      ? 'var(--success)'
                                      : 'var(--meta)',
                                    border: statusDone
                                      ? 'none'
                                      : '1px solid var(--border-soft)',
                                  }}
                                >
                                  {statusDone
                                    ? t('taskDetail.outputDone')
                                    : t('taskDetail.outputPending')}
                                </span>
                                {nextInput && (
                                  <span
                                    style={{
                                      fontSize: 'calc(11px * var(--font-scale))',
                                      color: 'var(--muted)',
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 2,
                                    }}
                                  >
                                    <span
                                      style={{
                                        color: 'var(--meta)',
                                        fontSize: 'calc(11px * var(--font-scale))',
                                      }}
                                    >
                                      →
                                    </span>{' '}
                                    {nextStage?.label}:{' '}
                                    {nextInput.name}
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

        {/* Review results */}
        {selectedReview && (
          <div>
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
                      : selectedReview.status === 'running'
                        ? t('taskDetail.reviewRunning')
                        : t('taskDetail.reviewWaiting')}
                </span>
              </div>
              {selectedReview.report && (
                <>
                  <div style={{ fontSize: 'calc(13px * var(--font-scale))', lineHeight: 1.6 }}>
                    {selectedReview.report.score !== null && (
                      <strong>
                        {t('taskDetail.scorePoints', {
                          score: selectedReview.report.score,
                        })}
                      </strong>
                    )}
                    {selectedReview.report.summary}
                  </div>
                  {selectedReview.report.issues.map(
                    (issue: any, index: number) => (
                      <div
                        key={`${issue.category}-${index}`}
                        style={{
                          fontSize: 'calc(11px * var(--font-scale))',
                          lineHeight: 1.5,
                          padding: '7px 9px',
                          borderRadius: 6,
                          background:
                            issue.severity === 'error'
                              ? 'color-mix(in oklab, var(--danger), transparent 90%)'
                              : 'color-mix(in oklab, var(--warn), transparent 90%)',
                        }}
                      >
                        <strong>{issue.description}</strong>
                        {issue.suggestion && (
                          <div>{issue.suggestion}</div>
                        )}
                      </div>
                    ),
                  )}
                </>
              )}
              {/* Review action buttons (edit mode only) */}
              {!readOnly &&
                (selectedReview.status === 'pending' ||
                  selectedReview.status === 'rejected') && (
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
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'flex-end',
                        gap: 8,
                      }}
                    >
                      {selectedReview.status === 'pending' ? (
                        <>
                          <Button
                            variant="ghost"
                            disabled={reviewActionPending}
                            onClick={() => onReviewAction?.('reject')}
                          >
                            {t('taskDetail.reject')}
                          </Button>
                          <Button
                            variant="primary"
                            disabled={reviewActionPending}
                            loading={reviewActionPending}
                            onClick={() => onReviewAction?.('approve')}
                          >
                            {t('taskDetail.approve')}
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="primary"
                          disabled={reviewActionPending}
                          loading={reviewActionPending}
                          onClick={() =>
                            onReviewAction?.('force-approve')
                          }
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

        {/* Review config drawer (edit mode only) */}
        {!readOnly && (
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
              {t('taskDetail.stageReviewConfig')}
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
              color: currentStageColor,
              background: `color-mix(in oklab, ${currentStageColor}, transparent 88%)`,
              padding: '2px 8px',
              borderRadius: 4,
            }}
          >
            {currentStage.label}
          </span>
        </div>

        {/* Chat messages */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            position: 'relative',
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
                    // 用户主动滚轮上滚在 capture 阶段已先行取消跟随；此处仅保护
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
                  .filter(isVisibleHistoryMessage)
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
              const orderedMessages =
                orderConversationMessages(
                  orderedMessagesRaw,
                  durationNowMs,
                )
              return orderedMessages.map((message: any) => {
                const stageKey =
                  message.context_step_key ||
                  message.step_key ||
                  'unknown'
                const msgs = [message]
                const stageInfo = stages.find(
                  (s: any) => s.key === stageKey,
                )
                const stageLabel =
                  message.channel === 'coordinator'
                    ? t('aiFlow.agent')
                    : stageInfo?.label || stageKey
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
                        const msgStageIndex =
                          stages.findIndex(
                            (s: any) =>
                              s.key === stageKey,
                          )
                        const msgStepStatus =
                          msgStageIndex >= 0
                            ? stageProgress[
                                msgStageIndex
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
                        const msgArtifacts =
                          isReview
                            ? artifacts.filter(
                                (artifact) =>
                                  artifact.step_key ===
                                  stageKey,
                              )
                            : []
                        const processEvents =
                          Array.isArray(
                            msg.events,
                          )
                            ? msg.events
                            : []
                        const isManualReview =
                          isReview &&
                          isManualReviewMessage(
                            msg,
                            reviews,
                          )
                        const isOwnUser = isUser && (!msg.author_device_id || msg.author_device_id === localDeviceId)
                        const sender = isUser
                          ? (isOwnUser ? t('aiFlow.me') : (msg.author_name || t('aiFlow.me')))
                          : isSystem
                            ? t(
                                'taskDetail.system',
                              )
                            : isCoordinator
                              ? t('aiFlow.agent')
                              : isManualReview
                                ? `${stageLabel} · ${t('taskDetail.manualReview')}`
                                : stageLabel
                        const initials =
                          isUser || isSystem
                            ? sender.slice(0, 2)
                            : isCoordinator
                              ? t(
                                  'aiFlow.agentInitials',
                                )
                              : stageAvatarText(
                                  stageLabel,
                                  t,
                                )
                        const senderColor =
                          isUser
                            ? 'var(--accent)'
                            : isSystem
                              ? 'var(--warn)'
                              : isReview
                                ? (stageInfo?.color ||
                                    'var(--warn)')
                                : isCoordinator
                                  ? 'var(--ai-assistant)'
                                  : (stageInfo?.color ||
                                      'var(--fg)')
                        const reviewLine =
                          isManualReview
                            ? t(
                                'taskDetail.manualReview',
                              )
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
                                  : t(
                                      'taskDetail.reviewRejected',
                                    ),
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
                            senderTitle={isUser && msg.author_device_name ? `${sender} · ${msg.author_device_name}` : undefined}
                            initials={initials}
                            color={senderColor}
                            content={messageContent}
                            projectId={projectId}
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
                              !readOnly && isUser
                                ? (content) => {
                                    // Handle edit user message — parent should provide
                                    if (onPromptChange && onSend) {
                                      onPromptChange(content)
                                      chatInputRef?.current?.focus()
                                    }
                                  }
                                : undefined
                            }
                            onSendToInput={
                              !readOnly && isUser && onPromptChange
                                ? (content) => {
                                    onPromptChange(content)
                                    chatInputRef?.current?.focus()
                                  }
                                : undefined
                            }
                            onA2uiAction={
                              !readOnly
                                ? onA2uiAction
                                : undefined
                            }
                            events={processEvents}
                            interactionsEnabled={msg.run_status === 'running'}
                            onInteractionRespond={
                              !readOnly
                                ? onInteractionRespond
                                : undefined
                            }
                            rootProps={{
                              ref:
                                i ===
                                msgs.length - 1
                                  ? (
                                      element,
                                    ) => {
                                      stageLastRef.current[
                                        stageKey
                                      ] = element
                                    }
                                  : undefined,
                              'data-stage-last-message':
                                i ===
                                msgs.length - 1
                                  ? stageKey
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
                                              'taskDetail.stageInitialInputTitle',
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
                                      : `@${stageLabel}`}
                                  </span>
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
                                    (stageInserts ?? [])
                                      .length > 0
                                  }
                                  prompt={
                                    msg.prompt
                                  }
                                  sessionId={
                                    isCoordinator
                                      ? (task
                                          ?.coordinator_session_id ||
                                          null)
                                      : isReview
                                        ? undefined
                                        : sessionIdForStep(
                                            stageKey,
                                          )
                                  }
                                  onViewPrompt={
                                    onViewingPromptChange
                                  }
                                  status={terminalMessageStatus(
                                    msg.run_status,
                                  )}
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
                                      (stageInserts ?? []).length > 0,
                                    )}
                                  />
                                )
                                : undefined
                            }
                            footer={
                              !isUser &&
                              !isSystem &&
                              msg.content &&
                              !(isReview &&
                                !msg.engine)
                                ? (
                                  <MessageResponseFooter
                                    content={stripA2uiBlocks(
                                      String(
                                        msg.content,
                                      ),
                                    )}
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
                                        : executionStageModel
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
                                    onContinueStage={
                                      !readOnly &&
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
                            {!readOnly &&
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
                                  {msgArtifacts.length >
                                    0 && (
                                    <div
                                      style={{
                                        display:
                                          'flex',
                                        flexDirection:
                                          'column',
                                        gap: 4,
                                      }}
                                    >
                                      <div
                                        style={{
                                          fontSize: 'calc(11px * var(--font-scale))',
                                          fontWeight: 600,
                                          color: 'var(--muted)',
                                          fontFamily:
                                            'var(--font-mono)',
                                          textTransform:
                                            'uppercase',
                                          letterSpacing:
                                            '0.08em',
                                        }}
                                      >
                                        {t(
                                          'taskDetail.reviewArtifacts',
                                        )}
                                      </div>
                                      {msgArtifacts.map(
                                        (
                                          artifact,
                                        ) => (
                                          <div
                                            key={
                                              artifact.path
                                            }
                                            role="button"
                                            tabIndex={0}
                                            aria-label={t(
                                              'taskDetail.openOutputAria',
                                              {
                                                name:
                                                  artifact.name,
                                              },
                                            )}
                                            onClick={() =>
                                              onOpenArtifact(
                                                artifact.name,
                                                artifact.step_key,
                                              )
                                            }
                                            onKeyDown={(
                                              event,
                                            ) => {
                                              if (
                                                event.key ===
                                                  'Enter' ||
                                                event.key ===
                                                  ' '
                                              ) {
                                                event.preventDefault()
                                                onOpenArtifact(
                                                  artifact.name,
                                                  artifact.step_key,
                                                )
                                              }
                                            }}
                                            title={t(
                                              'taskDetail.openFileTitle',
                                              {
                                                name:
                                                  artifact.name,
                                              },
                                            )}
                                            style={{
                                              display:
                                                'flex',
                                              alignItems:
                                                'center',
                                              gap: 8,
                                              padding:
                                                '6px 10px',
                                              background:
                                                'var(--surface)',
                                              borderRadius: 6,
                                              border:
                                                '1px solid var(--border-soft)',
                                              cursor:
                                                'pointer',
                                              fontSize: 'calc(13px * var(--font-scale))',
                                            }}
                                          >
                                            {artifact.is_dir
                                              ? (
                                                <Icon
                                                  name="folder"
                                                  size={14}
                                                  color="var(--accent)"
                                                  style={{
                                                    flexShrink: 0,
                                                  }}
                                                />
                                              )
                                              : (
                                                <span
                                                  style={{
                                                    width: 6,
                                                    height: 6,
                                                    borderRadius:
                                                      '50%',
                                                    background:
                                                      stageInfo
                                                        ?.color ||
                                                      'var(--accent)',
                                                    flexShrink: 0,
                                                  }}
                                                />
                                              )}
                                            <span
                                              style={{
                                                flex: 1,
                                                fontWeight: 500,
                                              }}
                                            >
                                              {
                                                artifact.name
                                              }
                                            </span>
                                            <span
                                              style={{
                                                fontSize: 'calc(11px * var(--font-scale))',
                                                color: 'var(--accent)',
                                              }}
                                            >
                                              {t(
                                                'common.open',
                                              )}
                                            </span>
                                          </div>
                                        ),
                                      )}
                                    </div>
                                  )}
                                  {!readOnly &&
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
                                  {!readOnly && (
                                    <div
                                      style={{
                                        display:
                                          'flex',
                                        justifyContent:
                                          'flex-end',
                                        gap: 8,
                                      }}
                                    >
                                      {msgReview!
                                          .status ===
                                        'pending' ? (
                                        <>
                                          <Button
                                            variant="ghost"
                                            disabled={
                                              reviewActionPending
                                            }
                                            onClick={() =>
                                              onReviewAction?.(
                                                'reject',
                                                msgReview!,
                                                stageKey,
                                              )
                                            }
                                          >
                                            {t(
                                              'taskDetail.reject',
                                            )}
                                          </Button>
                                          <Button
                                            variant="primary"
                                            disabled={
                                              reviewActionPending
                                            }
                                            loading={
                                              reviewActionPending
                                            }
                                            onClick={() =>
                                              onReviewAction?.(
                                                'approve',
                                                msgReview!,
                                                stageKey,
                                              )
                                            }
                                          >
                                            {t(
                                              'taskDetail.approve',
                                            )}
                                          </Button>
                                        </>
                                      ) : (
                                        <Button
                                          variant="primary"
                                          disabled={
                                            reviewActionPending
                                          }
                                          loading={
                                            reviewActionPending
                                          }
                                          onClick={() =>
                                            onReviewAction?.(
                                              'force-approve',
                                              msgReview!,
                                              stageKey,
                                            )
                                          }
                                        >
                                          {t(
                                            'taskDetail.forceApprove',
                                          )}
                                        </Button>
                                      )}
                                    </div>
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
              />
            )}

            {liveCoordinatorMessages.map(
              (message) => (
                <ChatMessageBubble
                  key={message.id}
                  role="assistant"
                  sender={t('aiFlow.agent')}
                  initials={t(
                    'aiFlow.agentInitials',
                  )}
                  color="var(--ai-assistant)"
                  content={
                    message.content || ''
                  }
                  projectId={projectId}
                  streaming={
                    message.status === 'running'
                  }
                  variant="bg"
                  onA2uiAction={
                    !readOnly
                      ? onA2uiAction
                      : undefined
                  }
                  events={message.events}
                  interactionsEnabled={message.status === 'running'}
                  onInteractionRespond={
                    !readOnly
                      ? onInteractionRespond
                      : undefined
                  }
                  header={
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
                        message.prompt
                      }
                      sessionId={
                        task?.coordinator_session_id ||
                        sessionIdForStep(
                          message.step_key,
                        )
                      }
                      onViewPrompt={
                        onViewingPromptChange
                      }
                      status={terminalMessageStatus(
                        message.status,
                      )}
                      projectId={projectId}
                    />
                  }
                  showLoading={
                    !message.content &&
                    message.status === 'running'
                  }
                  loading={
                    <StreamingStatusText label={t('bubble.thinking')} />
                  }
                  footer={
                    message.content ? (
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
                  {!readOnly &&
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
              ),
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
                sender={activeStage.label}
                initials={stageAvatarText(
                  activeStage.label,
                  t,
                )}
                color={activeStageColor}
                content={content}
                projectId={projectId}
                streaming={running}
                variant="bg"
                onA2uiAction={
                  !readOnly
                    ? onA2uiAction
                    : undefined
                }
                events={events}
                interactionsEnabled={Boolean(running)}
                onInteractionRespond={
                  !readOnly
                    ? onInteractionRespond
                    : undefined
                }
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
                  content ? (
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
                        executionStageModel
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
            visible={unreadMessages}
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
        {!readOnly && (
          <div
            style={{
              position: 'relative',
              padding: '14px 20px',
              borderTop: '1px solid var(--border-soft)',
              background: 'var(--bg)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              flexShrink: 0,
            }}
          >
            {chatTarget !== 'coordinator' && runningStages.length > 0 && (
              <PendingMessageInserts
                items={stageInserts ?? []}
                title={t('taskDetail.insertMessages')}
                titleTooltip={t('taskDetail.insertMessagesTitle', {
                  stage: runningStages[0]?.label ?? '',
                })}
                editingId={editingInsertId}
                editingContent={editingInsertContent}
                onEditingContentChange={onEditingInsertContentChange}
                onEditStart={onStageInsertEditStart}
                onEditSave={onStageInsertEditSave}
                onEditCancel={onStageInsertEditCancel}
                onSend={onStageInsertSend}
                onRemove={onStageInsertRemove}
                onSendAll={onSendAllInserts}
                onClear={onClearInserts}
              />
            )}
            {/* Chat target tabs */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                width: '100%',
                maxWidth: 800,
                marginInline: 'auto',
              }}
            >
              <div
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
                {runningStages.map((stage) => (
                  <button
                    key={stage.key}
                    type="button"
                    onClick={() =>
                      onChatTargetChange?.(
                        stage.key,
                      )
                    }
                    aria-pressed={
                      chatTarget === stage.key
                    }
                    title={t(
                      'taskDetail.stageTabTitle',
                      {
                        stage: stage.label,
                      },
                    )}
                    style={stageTabStyle(
                      stage.color || 'var(--accent)',
                      chatTarget === stage.key,
                    )}
                  >
                    {stage.label}
                  </button>
                ))}
                {resumableStages.map((stage) => (
                  <button
                    key={stage.key}
                    type="button"
                    onClick={() =>
                      onChatTargetChange?.(
                        stage.key,
                      )
                    }
                    aria-pressed={
                      chatTarget === stage.key
                    }
                    title={t(
                      resumableStatusOf(stage.key) === 'failed'
                        || resumableStatusOf(stage.key) === 'rejected'
                        ? 'taskDetail.failedStageTabTitle'
                        : resumableStatusOf(stage.key) === 'awaiting_review'
                          ? 'taskDetail.reviewWaitingStageTabTitle'
                          : 'taskDetail.stoppedStageTabTitle',
                      {
                        stage: stage.label,
                      },
                    )}
                    style={stageTabStyle(
                      stage.color || 'var(--accent)',
                      chatTarget === stage.key,
                    )}
                  >
                    {stage.label}
                  </button>
                ))}
              </div>
              {resumableTarget && (
                <span
                  style={{
                    fontSize: 'calc(11px * var(--font-scale))',
                    color: 'var(--warn)',
                  }}
                >
                  {t(resumableStatusOf(resumableTarget.key) === 'failed'
                    || resumableStatusOf(resumableTarget.key) === 'rejected'
                    ? 'taskDetail.failedStageHint'
                    : resumableStatusOf(resumableTarget.key) === 'awaiting_review'
                      ? 'taskDetail.reviewWaitingStageHint'
                      : 'taskDetail.stoppedStageHint', {
                    stage: resumableTarget.label,
                  })}
                </span>
              )}
              {!resumableTarget &&
                chatTarget !== 'coordinator' &&
                runningStages.length === 0 && (
                  <span
                    style={{
                      fontSize: 'calc(11px * var(--font-scale))',
                      color: 'var(--warn)',
                    }}
                  >
                    {t(
                      'taskDetail.stageNotRunningHint',
                    )}
                  </span>
                )}
            </div>

            {chatError && (
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
                {chatError}
              </div>
            )}

            <ChatInput
              projectId={projectId}
              availableCommands={availableCommands?.[
                chatTarget === 'coordinator'
                  ? 'coordinator:'
                  : `execution:${chatTarget}`
              ]}
              skillEngine={chatTarget === 'coordinator'
                ? coordinatorConfig?.resolved.engine
                : stages.find((stage) => stage.key === chatTarget)?.engine
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
                projectId
                  ? {
                      projectId,
                      prefix:
                        task?.id?.slice(0, 8) ??
                        '',
                      onError: () => {
                        /* handled by parent */
                      },
                    }
                  : undefined
              }
              stopTitle={
                chatTarget !== 'coordinator'
                  ? t('taskDetail.stopStageTitle')
                  : t('chatInput.stopGenerating')
              }
              config={
                {
                  projectId,
                  engines:
                    coordinatorConfig
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
              disabled={composerState.disabled}
              running={composerState.running}
              stopping={
                (chatTarget !== 'coordinator' &&
                  (stoppingStepKeys ?? [])
                    .length > 0) ||
                (chatTarget === 'coordinator' &&
                  (coordinatorStopping ??
                    false))
              }
              onStop={
                chatTarget !== 'coordinator' &&
                runningStages[0]
                  ? () =>
                      onStopStage?.(
                        runningStages[0].key,
                      )
                  : onStop ?? (() => {})
              }
              placeholder={
                resumableTarget
                  ? t('taskDetail.resumeStagePlaceholder', {
                      stage: resumableTarget.label,
                    })
                  : chatTarget !== 'coordinator' &&
                      runningStages[0]
                    ? t('taskDetail.stagePlaceholder', {
                        stage: runningStages[0].label,
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
                  ? t('taskDetail.resumeStageTitle', {
                      stage: resumableTarget.label,
                    })
                  : chatTarget !== 'coordinator'
                    ? t(
                        'taskDetail.stageInputTitle',
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
        {!readOnly && onClose && (
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

      {/* Recovered hint */}
      {renderRecoveredHint()}

      {/* Content split */}
      <div
        ref={contentSplitRef}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: `${splitRatio}fr ${SPLIT_HANDLE_WIDTH}px ${1 - splitRatio}fr`,
        }}
      >
        {/* Left panel */}
        {renderLeftPanel()}

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
        {renderConversation()}
      </div>
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
  const retryable =
    current.status === 'failed' && current.type === 'rerun_from_stage'
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
          crypto.randomUUID(),
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
        {t('taskDetail.proposalTitle', { type: current.type })}
      </div>
      <div style={{ fontSize: 'calc(13px * var(--font-scale))', color: 'var(--muted)' }}>
        {current.impact?.summary ||
          t('taskDetail.proposalTargetStage', {
            step: current.target_step_key || t('common.none'),
          })}
      </div>
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
