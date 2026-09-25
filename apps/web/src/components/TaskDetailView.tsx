import { useCompactLayout } from '../hooks/useCompactLayout'
import { buildTaskConversationTimeline, lastEventTimestamp } from './taskConversationFeed'
import { useTaskConversationScroll } from '../hooks/useTaskConversationScroll'
import { ComposerOverlayHostContext } from '../hooks/useComposerOverlayClearance'
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
import ChatMessageBubble from './ChatMessageBubble'
import AssistantThinkingMessage from './AssistantThinkingMessage'
import StreamingStatusText from './StreamingStatusText'
import ConversationNewMessagesButton from './ConversationNewMessagesButton'
import ChatInput, {
  type ChatInputEngineConfig,
  type ChatInputImageAttach,
} from './ChatInput'
import MessageResponseFooter, {
  usageFromEvents,
} from './MessageResponseFooter'
import { stripA2uiBlocks } from '../utils/a2ui'
import MarkdownMessage from './MarkdownMessage'
import type { ReviewDecisionAction } from './ReviewDecisionActions'
import ProcessTrace from './ProcessTrace'
import Icon from './Icon'
import PendingMessageInserts from './PendingMessageInserts'
import TaskStepProgressGraph from './TaskStepProgressGraph'
import TaskStepIoPanel from './TaskStepIoPanel'
import TaskDetailHeader from './TaskDetailHeader'
import TaskDetailDescription from './TaskDetailDescription'
import TaskDetailTabs from './TaskDetailTabs'
import TaskChatTargetTabs from './TaskChatTargetTabs'
import TaskConversationMessage from './TaskConversationMessage'
import TaskReviewConfigPanel from './TaskReviewConfigPanel'
import TaskReviewResult from './TaskReviewResult'
import TaskExecutionAnalysis from './TaskExecutionAnalysis'
import TaskArtifactBrowser from './TaskArtifactBrowser'
import TaskGitWorkspace from './git/TaskGitWorkspace'
import {
  isReviewActionable,
  isStepResumableWithMessage,
  isSelectedStepRunning,
  findActionablePendingReview,
  resolveTaskComposerState,
  shouldRenderLegacyExecution,
  stepAvatarText,
  taskTargetStepsInWorkflowOrder,
} from '../pages/taskDetailChat'
import { useI18n } from '../i18n'
import { ActionConversationMessage, TaskActionButtons } from './TaskActionShortcuts'
import { useTaskActions } from './useActionRuns'

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

function hasProcessEvents(events: any[]) {
  return events.some((event) => PROCESS_EVENT_TYPES.has(event.type))
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
    scheduled_start_at?: string | null
    scheduled_start_state?: string | null
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
  artifactDirectory?: string
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
  onSetFailedExecutionComplete?: (messageId: string, artifactRound: number) => void
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

  // ── Description editing (owner mode only) ──
  descriptionEditable?: boolean

  // ── Prompt editing (edit mode only) ──
  onOpenPromptEditor?: () => void

  // ── Review config (edit mode only) ──
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
  artifactDirectory,
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
  onSetFailedExecutionComplete,
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
  descriptionEditable,
  // Prompt
  onOpenPromptEditor,
  // Review config
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

  const {
    scrollRef, endRef, contentRef, stepLastRef, pendingScrollRef,
    scrolledToBottom, unreadMessages, registerOverlay, overlayPaddingBottom,
    onWheelCapture, onKeyDownCapture, onScroll, jumpToLatest,
  } = useTaskConversationScroll({
    historyMessages, liveMessages, events, content,
    chatScrollRef, chatEndRef, shouldFollowMessagesRef, lastProgrammaticScrollTopRef,
    stepLastMessageRefs, pendingStepScrollRef, hasUnreadMessages,
    onUnreadMessagesChange, onLoadOlderHistory,
  })
  // ── Helpers ──

  const {
    liveCoordinatorMessages,
    hasStructuredExecutionMessage,
    orderedMessages,
    latestStepMessageIds,
    latestExecutionMessageIds,
  } = useMemo(
    () => buildTaskConversationTimeline({
      historyMessages, liveMessages, actionRuns: taskActions.runs,
      coordinatorRunning: coordinatorRunning ?? false,
      actionTitle: (title) => t('actionShortcuts.runTitle', { title }),
    }),
    [historyMessages, liveMessages, taskActions.runs, coordinatorRunning, t],
  )

  const selectedReview = reviews.find(
    (review) => review.step_key === currentStep.key,
  )
  const actionablePendingReview = useMemo(
    () => findActionablePendingReview(reviews, stepProgress),
    [reviews, stepProgress],
  )
  const selectedReviewActionable = isReviewActionable(
    selectedReview,
    reviews,
    stepProgress[selectedStep]?.status,
  )
  const renderArtifactPanel = () => (
    <TaskArtifactBrowser
      artifacts={artifacts}
      artifactDirectory={artifactDirectory}
      projectId={projectId}
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

  // ── Render: Left panel ──

  const renderLeftPanel = () => {
    if (!task) return null
    return (
      <div className="task-detail-step-panel">
        <TaskDetailDescription key={task.id} task={task} projectId={projectId} editable={descriptionEditable} />

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

        <TaskStepIoPanel currentStep={currentStep} steps={steps}
          workflowConnections={workflowConnections} progress={stepProgress[selectedStep]}
          artifacts={artifacts} artifactInputSnapshots={artifactInputSnapshots}
          canChat={canChat} restartingStepKeys={restartingStepKeys}
          onRestartStepWithFreshSession={onRestartStepWithFreshSession}
          onOpenArtifact={onOpenArtifact} locale={locale} />

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
        {selectedReview && <TaskReviewResult review={selectedReview} projectId={projectId}
          actionable={selectedReviewActionable} pending={reviewActionPending}
          comment={reviewComment} onCommentChange={onReviewCommentChange}
          onAction={onReviewAction} containerRef={mobileReviewRef} />}

        {/* Review config drawer (edit mode only) */}
        {onSaveReviewConfig && <TaskReviewConfigPanel projectId={projectId}
          mode={editReviewMode} onModeChange={onEditReviewModeChange}
          retries={editReviewRetries} onRetriesChange={onEditReviewRetriesChange}
          prompt={editReviewPrompt} onPromptChange={onEditReviewPromptChange}
          onSave={onSaveReviewConfig} />}

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
            onWheelCapture={onWheelCapture}
            onKeyDownCapture={onKeyDownCapture}
            onScroll={onScroll}
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
              return orderedMessages.map((message: any) => {
                if (message.thinkingPlaceholder) {
                  return <AssistantThinkingMessage
                    key={message.id}
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
                }
                if (message.channel === 'action') {
                  return <ActionConversationMessage
                    key={message.id}
                    message={message}
                    run={message.actionRun}
                    onStop={canChat ? (runId) => { void taskActions.stop(runId) } : undefined}
                  />
                }
                return <TaskConversationMessage
                  key={message.id}
                  message={message}
                  canChat={canChat}
                  latestStepMessageIds={latestStepMessageIds}
                  latestExecutionMessageIds={latestExecutionMessageIds}
                  stepLastRef={stepLastRef}
                    task={task}
                    steps={steps}
                    stepProgress={stepProgress}
                    reviews={reviews}
                    artifacts={artifacts}
                    locale={locale}
                    onOpenArtifact={onOpenArtifact}
                    sessionIdForStep={sessionIdForStep}
                    onSetFailedExecutionComplete={onSetFailedExecutionComplete}
                    onRestartStepWithFreshSession={onRestartStepWithFreshSession}
                    restartingStepKeys={restartingStepKeys}
                    onPromptChange={onPromptChange}
                    onSend={onSend}
                    chatInputRef={chatInputRef}
                    onA2uiAction={onA2uiAction}
                    onInteractionRespond={onInteractionRespond}
                    onLoadMessageEvents={onLoadMessageEvents}
                    stepInserts={stepInserts}
                    livePromptOverrides={livePromptOverrides}
                    onViewingPromptChange={onViewingPromptChange}
                    onRetryFailedMessage={onRetryFailedMessage}
                    retryingFailedMessageIds={retryingFailedMessageIds}
                    reviewActionPending={reviewActionPending}
                    onReviewAction={onReviewAction}
                    reviewComment={reviewComment}
                    onReviewCommentChange={onReviewCommentChange}
                    projectId={projectId}
                    executionStepModel={executionStepModel}
                    onProposalOverride={onProposalOverride}
                    proposalOverrides={proposalOverrides}
                />
              })
            })()}

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
            onClick={jumpToLatest}
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
            {onSendPrompt && !compact && <TaskActionButtons state={taskActions} onFillPrompt={onPromptChange} onSendPrompt={onSendPrompt} />}
            {onSendPrompt && compact && taskActions.error && <span role="alert" style={{ color: 'var(--danger)' }}>{taskActions.error}</span>}
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
            <TaskChatTargetTabs target={chatTarget} steps={targetSteps}
              stepProgress={stepProgress} runningStepKeys={runningSteps.map((step) => step.key)}
              resumableTarget={resumableTarget} onSelect={onChatTargetChange} />

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
              left={onSendPrompt && compact ? <TaskActionButtons state={taskActions} onFillPrompt={onPromptChange} onSendPrompt={onSendPrompt} compact /> : undefined}
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
      {task && <TaskDetailHeader task={task} locale={locale} activeStep={activeStep}
        activeStepColor={activeStepColor} taskCompleted={taskCompleted}
        headerActions={headerActions} taskHeaderExtra={taskHeaderExtra} onClose={onClose}
        onHeaderPointerDown={onHeaderPointerDown} onHeaderKeyDown={onHeaderKeyDown}
        onHeaderDoubleClick={onHeaderDoubleClick} />}

      {(!compact || canShowAnalysis || gitEnabled) && <TaskDetailTabs
        className="task-detail-primary-tabs" ariaLabel={t('executionAnalysis.title')}
        selected={detailMode} onSelect={setDetailMode}
        tabs={[
          { id: 'detail', label: t('taskDetail.detailTab') },
          ...(!compact ? [{ id: 'artifacts', label: t('mobile.artifacts') }] : []),
          ...(canShowAnalysis ? [{ id: 'analysis', label: t('executionAnalysis.title') }] : []),
          ...(gitEnabled && (gitProjectId || projectId) ? [{ id: 'git', label: t('git.taskWorkspace') }] : []),
        ] as Array<{ id: typeof detailMode; label: string }>} />}

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
      {compact && <TaskDetailTabs className="mobile-detail-tabs"
        selected={mobileTab} onSelect={setMobileTab}
        tabs={(['conversation', 'steps', 'artifacts'] as const).map(id => ({ id, label: t(`mobile.${id}`) }))} />}

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
        style={{ gridTemplateColumns: `${splitRatio}fr ${SPLIT_HANDLE_WIDTH}px ${1 - splitRatio}fr` }}
      >
        {/* Left panel */}
        <div className="task-detail-steps">{renderLeftPanel()}</div>

        {/* Split handle */}
        <div className="task-detail-split-handle" onPointerDown={beginSplitResize}>
          <span className="task-detail-split-grip" aria-hidden="true">
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
