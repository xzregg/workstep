import { toMilliseconds } from '../utils/datetime'
import { mergeInteractionEvents } from '../utils/interaction'
import { mergePlanEvents } from '../utils/plan'
import {
  CUSTOM,
  customValue,
  isCustom,
  toolName,
} from '../utils/agui.ts'
import { zhCNT, type TFunction } from '../i18n'

export interface OptimisticUserMessage {
  id: string
  role: 'user'
  content: string
  step_key: string
  run_status: 'pending'
  created_at: string
  events: never[]
}

export interface OptimisticCoordinatorMessage extends OptimisticUserMessage {
  channel: 'coordinator'
  context_step_key: string
}

export interface TaskStepStartState {
  status: string
  started_at: string | null
}

interface ConversationMessage {
  id?: string
  channel?: string
  role?: string
  step_key?: string
  content?: unknown
  run_status?: string
  status?: string
  events?: Array<{ type?: string; data?: Record<string, unknown> }>
  prompt?: string | null
  created_at?: string
  started_at?: string | null
  review_run_id?: string | null
  engine?: string | null
  author_id?: string | null
  author_name?: string | null
  author_device_id?: string | null
  author_device_name?: string | null
}

function eventSequence(event: any): number | null {
  const value = event?.event_sequence ?? event?.sequence ?? event?.seq
  return typeof value === 'number' ? value : null
}

export function mergeLoadedTaskMessageEvents(
  messages: any[],
  messageId: string,
  loadedEvents: any[],
  detail: { complete: boolean; next_cursor: number | null },
): any[] {
  return messages.map((message) => {
    if (message.id !== messageId) return message
    const merged = [...loadedEvents, ...(message.events ?? [])]
    const seen = new Set<string>()
    const events = merged.filter((event) => {
      const sequence = eventSequence(event)
      const key = sequence === null
        ? JSON.stringify(event)
        : `sequence:${sequence}:${event.type ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).sort((left, right) => (
      (eventSequence(left) ?? Number.MAX_SAFE_INTEGER)
      - (eventSequence(right) ?? Number.MAX_SAFE_INTEGER)
    ))
    return {
      ...message,
      events,
      event_detail: {
        ...message.event_detail,
        available: true,
        loaded: true,
        loading: false,
        complete: detail.complete,
        next_cursor: detail.next_cursor,
        error: '',
      },
    }
  })
}

export function mergeRefreshedTaskHistory(current: any[], refreshed: any[]): any[] {
  const currentById = new Map(current.map((message) => [message.id, message]))
  const merged = refreshed.map((message) => {
    const existing = currentById.get(message.id)
    if (!existing?.event_detail?.loaded) return message
    return {
      ...message,
      events: existing.events,
      event_detail: existing.event_detail,
    }
  })
  const refreshedIds = new Set(refreshed.map((message) => message.id))
  const refreshedSequences = refreshed
    .map((message) => message.sequence)
    .filter((sequence): sequence is number => typeof sequence === 'number')
  const oldestRefreshedSequence = refreshedSequences.length > 0
    ? Math.min(...refreshedSequences)
    : null
  return [
    ...current.filter((message) => {
      if (refreshedIds.has(message.id)) return false
      if (String(message.id).startsWith('pending-')) return true
      return oldestRefreshedSequence !== null
        && typeof message.sequence === 'number'
        && message.sequence >= oldestRefreshedSequence
    }),
    ...merged,
  ]
}

interface MessageReview {
  id: string
  step_key: string
  status?: string
  mode?: string
  started_at?: string | null
  reviewer_name?: string | null
  reviewer_device_name?: string | null
}

export function reviewActorLabel(review: MessageReview): string | undefined {
  const name = review.reviewer_name?.trim()
  if (!name) return undefined
  const deviceName = review.reviewer_device_name?.trim()
  return deviceName ? `${name} · ${deviceName}` : name
}

function hasMessageContent(content: unknown): boolean {
  return typeof content === 'string' && content.trim().length > 0
}

function readableError(value: unknown, depth = 0): string {
  if (depth > 6 || value === undefined || value === null) return ''
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return readableError(
      record.message ?? record.error ?? record.detail,
      depth + 1,
    )
  }
  const text = String(value).trim()
  if (!text) return ''
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      const nested = readableError(parsed, depth + 1)
      if (nested) return nested
    } catch {
      // Plain error text can legitimately start with a brace.
    }
  }
  return text
}

export function resolveMessageError(events?: readonly any[] | null): string {
  for (let index = (events?.length ?? 0) - 1; index >= 0; index--) {
    const event = events![index]
    let value: unknown
    if (isCustom(event, CUSTOM.error)) {
      value = customValue(event)
    } else if (event?.type === 'error') {
      value = event.data
    } else if (event?.type === 'RUN_ERROR' || event?.type === 'TEXT_MESSAGE_END') {
      value = event.error ?? event.data?.error
    } else {
      continue
    }
    const message = readableError(value)
    if (message) return message
  }
  return ''
}

const LOST_ENGINE_SESSION_PATTERNS = [
  /no rollout found for thread id/i,
  /No conversation found with session ID/i,
  /session not found/i,
  /invalid session/i,
  /session id .* (?:not found|does not exist)/i,
]

/**
 * 引擎会话在磁盘上丢失（Codex rollout 被清理、Claude 会话文件缺失等）。
 * 这类错误可以用同一个阶段提示词重新建会话重跑，不需要用户重写上下文。
 */
export function isLostEngineSessionError(error?: string | null): boolean {
  if (!error) return false
  return LOST_ENGINE_SESSION_PATTERNS.some((pattern) => pattern.test(error))
}

const TERMINAL_EXECUTION_STATUSES = ['cancelled', 'stopped', 'failed']
// 阶段正在执行时只能实时注入，不能按「带消息重跑」处理。
const ACTIVE_STAGE_STATUSES = [
  'running',
  'reviewing',
  'retrying',
  'rework',
  'rework_waiting',
]
const MESSAGE_RESUMABLE_STAGE_STATUSES = [
  'cancelled',
  'failed',
  'rejected',
  'awaiting_review',
  'passed',
  'skipped',
]

/**
 * 是否可以把消息发给某个阶段并（重新）执行它。
 *
 * 规则：只要该阶段执行过一次（不管成功还是失败），就允许 @。
 * 执行中的阶段不接受重跑（走实时注入），从未执行过的 `pending` 阶段也不允许。
 */
export function isStageResumableWithMessage(
  status?: string,
  hasHistory?: boolean,
): boolean {
  if (status !== undefined && ACTIVE_STAGE_STATUSES.includes(status)) return false
  if (status !== undefined && MESSAGE_RESUMABLE_STAGE_STATUSES.includes(status)) {
    return true
  }
  return hasHistory === true
}

export function isSelectedStageRunning(
  target: string,
  runningStageKeys: readonly string[],
): boolean {
  return target !== 'coordinator' && runningStageKeys.includes(target)
}

export function resolveTaskChatTarget(
  current: string | 'coordinator',
  runningStageKeys: readonly string[],
  resumableStageKeys: readonly string[],
): string | 'coordinator' {
  if (current !== 'coordinator') {
    if (
      runningStageKeys.includes(current)
      || resumableStageKeys.includes(current)
    ) {
      return current
    }
  }
  if (current === 'coordinator') return 'coordinator'
  return runningStageKeys[0] ?? resumableStageKeys[0] ?? 'coordinator'
}

interface StageInsertAutoDrainState {
  previousKey: string | null
  stageRunKey: string
  queueReady: boolean
  activeStageRunning: boolean
  autoDraining: boolean
  awaitingRunStart: boolean
  editingInsert: boolean
  queueLength: number
}

/** 只有同一任务阶段恢复为同一队列的空闲态时，才允许自动推进插入消息。 */
export function shouldAutoDrainStageInsert({
  previousKey,
  stageRunKey,
  queueReady,
  activeStageRunning,
  autoDraining,
  awaitingRunStart,
  editingInsert,
  queueLength,
}: StageInsertAutoDrainState): boolean {
  return Boolean(stageRunKey)
    && queueReady
    && previousKey !== null
    && previousKey === stageRunKey
    && !activeStageRunning
    && !autoDraining
    && !awaitingRunStart
    && !editingInsert
    && queueLength > 0
}

export interface ArtifactRoundChoice {
  step_key: string
  round: number
  is_latest: boolean
  is_selected: boolean
  logical_name?: string | null
  name: string
}

export function findPreferredArtifact<T extends ArtifactRoundChoice>(
  artifacts: readonly T[],
  name: string,
  preferredStepKey?: string,
): T | undefined {
  const normalize = (value: string) =>
    value.toLocaleLowerCase().replace(/[\s_.-]/g, '')
  const normalizedName = normalize(name)
  const candidates = preferredStepKey
    ? artifacts.filter((artifact) => artifact.step_key === preferredStepKey)
    : artifacts
  const preferred = candidates.filter((artifact) => artifact.is_selected)
  const latest = candidates.filter((artifact) => artifact.is_latest)
  const ordered = [...preferred, ...latest, ...candidates]
  return (
    ordered.find((artifact) => artifact.logical_name === name) ||
    ordered.find((artifact) => {
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

export function resolveMessageReview<T extends MessageReview>(
  message: ConversationMessage,
  reviews: readonly T[],
): T | undefined {
  if (message.channel !== 'review' && message.role !== 'review') return undefined
  const eventReviewId = message.events?.find((event) => (
    event.type === 'review_context' && event.data?.review_run_id
  ))?.data?.review_run_id
  const reviewId = String(message.review_run_id || eventReviewId || '')
  if (reviewId) return reviews.find((review) => review.id === reviewId)

  const messageStartedAt = toMilliseconds(message.started_at)
  if (messageStartedAt !== null) {
    const timestampMatch = reviews.find((review) => (
      review.step_key === message.step_key
      && toMilliseconds(review.started_at) === messageStartedAt
    ))
    if (timestampMatch) return timestampMatch
  }

  const stageReviews = reviews.filter((review) => review.step_key === message.step_key)
  return stageReviews.length === 1 ? stageReviews[0] : undefined
}

export function isMessageReviewActionable<T extends MessageReview>(
  message: ConversationMessage,
  reviews: readonly T[],
  stepStatus?: string,
): boolean {
  if (stepStatus !== 'awaiting_review') return false
  const review = resolveMessageReview(message, reviews)
  if (!review || (review.status !== 'pending' && review.status !== 'rejected')) {
    return false
  }
  const stageReviews = reviews.filter((item) => item.step_key === review.step_key)
  const latest = stageReviews.reduce<T | undefined>((current, item) => {
    if (!current) return item
    const currentTime = toMilliseconds(current.started_at) ?? Number.NEGATIVE_INFINITY
    const itemTime = toMilliseconds(item.started_at) ?? Number.NEGATIVE_INFINITY
    return itemTime > currentTime ? item : current
  }, undefined)
  return latest?.id === review.id
}

export function isManualReviewMessage<T extends MessageReview>(
  message: ConversationMessage,
  reviews: readonly T[],
): boolean {
  if (message.channel !== 'review' && message.role !== 'review') return false
  const review = resolveMessageReview(message, reviews)
  if (review) return review.mode === 'manual'
  // 无匹配审核记录的旧数据兜底：人工审核不运行引擎，消息无引擎字段。
  return !message.engine
}

export function isVisibleHistoryMessage(message: ConversationMessage): boolean {
  if (
    (message.channel === 'review' || message.role === 'review')
    && message.events?.some((event) => (
      event.type === 'review_context' && event.data?.status === 'skipped'
    ))
  ) {
    return false
  }
  if (message.channel === 'review') return hasMessageContent(message.content)
  if (message.channel === 'coordinator') return true
  if (message.role === 'user' || message.role === 'system') return true
  // 已停止/失败但无内容的执行消息也要保留展示（附带「已停止/失败」状态徽标），
  // 不能因为没产出内容就从对话里消失。
  return message.run_status === 'running'
    || TERMINAL_EXECUTION_STATUSES.includes(message.run_status || '')
    || hasMessageContent(message.content)
}

export function isVisibleLiveExecutionMessage(message: ConversationMessage): boolean {
  // 实时插入的用户消息由乐观/历史渲染呈现（右侧 + @阶段名），
  // 不应再以左侧执行消息的身份出现。
  if (message.role === 'user') return false
  return (message.channel === 'execution' || message.channel === 'review')
    && (message.status === 'running'
      || TERMINAL_EXECUTION_STATUSES.includes(message.status || '')
      || hasMessageContent(message.content))
}

export function isUnpersistedLiveMessage(
  message: ConversationMessage,
  persistedIds: ReadonlySet<string>,
): boolean {
  return !message.id || !persistedIds.has(message.id)
}

export function mergeHistoryMessageWithLive(
  historyMessage: Record<string, any>,
  liveMessage?: Record<string, any>,
): Record<string, any> {
  if (!liveMessage) return historyMessage
  return {
    ...historyMessage,
    content: hasMessageContent(liveMessage.content)
      ? liveMessage.content
      : historyMessage.content,
    events: mergePlanEvents(
      historyMessage.events,
      mergeInteractionEvents(historyMessage.events, liveMessage.events),
    ),
    // 实时插入的用户消息不带完成事件（引擎只发 live_message 确认），
    // 保持乐观消息的 completed，避免右侧用户消息被误标为 streaming。
    run_status: liveMessage.role === 'user' || historyMessage.role === 'user'
      ? historyMessage.run_status
      : liveMessage.status || historyMessage.run_status,
    engine: liveMessage.engine || historyMessage.engine,
    model: liveMessage.model || historyMessage.model,
    created_at: liveMessage.created_at || historyMessage.created_at,
    prompt: resolveMessagePrompt(historyMessage.prompt, liveMessage.prompt),
  }
}

/**
 * Order conversation messages by their effective completion time:
 * - finished stage messages sort by `ended_at` (完成/中断时间);
 * - still-running stage messages sort by `now` (创建时间 + 已进行时长), so any
 *   stage output that is still going (or finished) after the user's message
 *   lands below the inserted user message instead of above it;
 * - user messages anchor by their send time (`created_at`).
 * Review and execution messages in the same displayed second use `sequence`,
 * so the review stays after the stage output it reviews without faking time.
 * `sequence` is also kept as a tiebreaker for other same-instant messages.
 */
export function orderConversationMessages(
  messages: Array<Record<string, any>>,
  now: number = Date.now(),
): Array<Record<string, any>> {
  const effectiveTime = (message: Record<string, any>): number => {
    if (message.role !== 'user' && (
      message.run_status === 'running' || message.status === 'running'
    )) {
      return now
    }
    if (message.role === 'user') {
      return toMilliseconds(message.created_at) ?? 0
    }
    return toMilliseconds(message.ended_at)
      ?? toMilliseconds(message.created_at)
      ?? 0
  }
  return [...messages].sort((left, right) => {
    const leftTime = effectiveTime(left)
    const rightTime = effectiveTime(right)
    const leftStage = left.context_step_key || left.step_key
    const rightStage = right.context_step_key || right.step_key
    const isExecutionReviewPair = leftStage === rightStage
      && left.role !== 'user'
      && right.role !== 'user'
      && ((left.channel === 'execution' && right.channel === 'review')
        || (left.channel === 'review' && right.channel === 'execution'))
    // 同一阶段的执行与审核消息始终按服务端 sequence 排列：执行消息的
    // ended_at 可能在整个阶段（含审核）收尾时才写入，晚于审核的 ended_at，
    // 只按时间排会把审核顶到阶段输出上方。
    if (isExecutionReviewPair) {
      const leftSeq = left.sequence
      const rightSeq = right.sequence
      if (typeof leftSeq === 'number' && typeof rightSeq === 'number') {
        return leftSeq - rightSeq
      }
    }
    if (leftTime !== rightTime) return leftTime - rightTime
    const leftSeq = left.sequence
    const rightSeq = right.sequence
    if (typeof leftSeq === 'number' && typeof rightSeq === 'number') {
      return leftSeq - rightSeq
    }
    return (toMilliseconds(left.created_at) ?? 0)
      - (toMilliseconds(right.created_at) ?? 0)
  })
}

export function liveExecutionStatus(
  events: Array<{
    type?: string
    data?: Record<string, unknown>
    name?: string
    value?: Record<string, unknown>
    status?: string
    toolCallName?: string
  }>,
  t: TFunction = zhCNT,
  hasPendingInserts = false,
): string {
  // 倒序遍历代替 [...events].reverse()：running 消息每次渲染都要取最新状态
  // 事件，整数组复制在数千条事件时是纯粹的内存/CPU 浪费。
  let latest: (typeof events)[number] | undefined
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if ([
      'tool_use', 'tool_result', 'thinking_delta', 'status', 'message_started', 'subagent',
      'TOOL_CALL_START', 'TOOL_CALL_RESULT', 'REASONING_MESSAGE_CHUNK',
      'RUN_STARTED', 'TEXT_MESSAGE_START',
    ].includes(event.type || '')
      || isCustom(event, CUSTOM.subagent)
      || isCustom(event, CUSTOM.status)) {
      latest = event
      break
    }
  }
  if (latest && (latest.type === 'subagent' || isCustom(latest, CUSTOM.subagent))) {
    const value = isCustom(latest, CUSTOM.subagent)
      ? customValue(latest)
      : latest.data
    const status = String(value?.status || '')
    if (['running', 'pending', 'paused', 'in_progress'].includes(status)) {
      return t('chat.subagentRunning')
    }
  }
  if (latest?.type === 'tool_use' || latest?.type === 'TOOL_CALL_START') {
    const name = latest.type === 'TOOL_CALL_START'
      ? String(toolName(latest) || t('chat.tool'))
      : String(latest.data?.name || t('chat.tool'))
    return t('chat.toolRunning', { name })
  }
  if (latest?.type === 'tool_result' || latest?.type === 'TOOL_CALL_RESULT') {
    return t('chat.toolDone')
  }
  if (latest?.type === 'thinking_delta' || latest?.type === 'REASONING_MESSAGE_CHUNK') {
    return t('chat.thinking')
  }
  const statusValue = latest?.type === 'RUN_STARTED'
    || latest?.type === 'RUN_FINISHED'
    || latest?.type === 'RUN_ERROR'
    ? latest.status
    : isCustom(latest ?? {}, CUSTOM.status)
      ? customValue(latest ?? {}).status
      : latest?.data?.status
  if (latest?.type === 'status' && statusValue === 'initializing') {
    return t('chat.engineInitializing')
  }
  if (latest?.type === 'status' && statusValue === 'idle_timeout') {
    return t('chat.idleTimeout')
  }
  if ((latest?.type === 'status' || latest?.type === 'RUN_FINISHED')
    && statusValue === 'done') {
    // 只有「插入消息」面板有待发送消息时才提示等待插入；
    // 否则本轮回复已完成，阶段正在收尾，直接显示处理中。
    return hasPendingInserts ? t('chat.waitingInjection') : t('chat.processing')
  }
  return t('chat.processing')
}

export function isNearConversationBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = 80,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold
}

type TextSelection = Pick<Selection, 'anchorNode' | 'focusNode' | 'isCollapsed'>

/** 用户正在会话区选择文字时暂停自动跟随，避免新 token 把选区拖离视口。 */
export function hasActiveSelectionWithin(
  element: Element | null,
  selection: TextSelection | null | undefined,
): boolean {
  if (!element || !selection || selection.isCollapsed) return false
  const { anchorNode, focusNode } = selection
  return Boolean(
    (anchorNode && element.contains(anchorNode))
    || (focusNode && element.contains(focusNode)),
  )
}

/**
 * 区分 scroll 事件是「用户手动滚动」还是「内容高度变化引发的浏览器自动钳制」。
 *
 * 对话内容整体变矮时（如思考块结束后自动折叠、过程追踪收起），浏览器会把
 * scrollTop 自动钳制到新的底部并触发 scroll 事件。只看 scrollTop 减小会把这次
 * 钳制误判为“用户向上滚动”，从而错误关闭跟随（钉底）。
 *
 * 判定：scrollTop 减小 + 同一事件里 scrollHeight 也减小 + 钳制后恰好落在底部，
 * 视为自动钳制（保留原跟随状态，不取消跟随）；
 * scrollTop 减小但高度未减小则是用户手动上滚（应取消跟随）。
 * 用户滚轮/键盘上滚在 capture 阶段已先行取消跟随，因此不会在此被保留。
 */
export function isAutoShrinkClamp({
  scrollTop,
  prevScrollTop,
  scrollHeight,
  prevScrollHeight,
  clientHeight,
}: {
  scrollTop: number
  prevScrollTop: number
  scrollHeight: number
  prevScrollHeight: number
  clientHeight: number
}): boolean {
  if (!(scrollTop < prevScrollTop)) return false
  if (!(scrollHeight < prevScrollHeight)) return false
  return scrollHeight - scrollTop - clientHeight <= 1
}

type ConversationNavigationIntent =
  | { type: 'wheel'; deltaY: number }
  | { type: 'key'; key: string }

/** 在浏览器真正更新 scrollTop 前识别“查看较早消息”的用户意图。 */
export function shouldPauseConversationFollow(
  intent: ConversationNavigationIntent,
): boolean {
  if (intent.type === 'wheel') return intent.deltaY < 0
  return intent.key === 'ArrowUp' || intent.key === 'PageUp' || intent.key === 'Home'
}

interface TaskComposerStateInput {
  target: 'coordinator' | 'stage'
  stageRunning?: boolean
  stageResuming?: boolean
  coordinatorRunning?: boolean
  prompt?: string
}

/** Keep the stage insert/send state and the stop-button state on one condition. */
export function resolveTaskComposerState({
  target,
  stageRunning = false,
  stageResuming = false,
  coordinatorRunning = false,
  prompt = '',
}: TaskComposerStateInput): { disabled: boolean; running: boolean } {
  if (target === 'coordinator') {
    return { disabled: coordinatorRunning, running: coordinatorRunning }
  }
  if (stageResuming) return { disabled: true, running: true }
  return {
    disabled: false,
    running: stageRunning && prompt.trim().length === 0,
  }
}

export function shouldRenderLegacyExecution(
  running: boolean,
  hasProcessEvents: boolean,
  content: string,
  hasStructuredExecutionMessage: boolean,
): boolean {
  return !hasStructuredExecutionMessage
    && (running || hasProcessEvents || content.length > 0)
}

export function resolveMessagePrompt(
  persistedPrompt?: string | null,
  livePrompt?: string | null,
): string | null {
  const normalizedLivePrompt = livePrompt?.trim()
  return normalizedLivePrompt || persistedPrompt || null
}

export function stageAvatarText(label: string, t: TFunction = zhCNT): string {
  const normalized = label.trim()
  return normalized.slice(0, 2) || t('chat.stageFallback')
}

export function isTaskNotStarted(steps: TaskStepStartState[]): boolean {
  return steps.length > 0 && steps.every((step) =>
    step.started_at === null
    && (step.status === 'pending' || step.status === 'skipped')
  )
}

export function resolveStageDisplayStatus(
  status: string,
  previousStatus?: string | null,
): string {
  return status === 'pending' && previousStatus
    ? previousStatus
    : status
}

export function isTaskCompleted(steps: TaskStepStartState[]): boolean {
  return steps.length > 0
    && !isTaskNotStarted(steps)
    && steps.every((step) => step.status === 'passed' || step.status === 'skipped')
}

interface TaskDetailAdvanceStateInput {
  taskNotStarted: boolean
  running: boolean
  taskStatus?: string
  stepStates: Array<{ status?: string }>
  activeStepStatus?: string
  reviewActionPending: boolean
  hasActiveReview: boolean
  t: TFunction
}

/**
 * 任务详情底部主操作按钮的文案与禁用状态。owner 弹窗与分享页共用，
 * 避免两处状态机漂移。
 */
export function resolveTaskDetailAdvanceState({
  taskNotStarted,
  running,
  taskStatus,
  stepStates,
  activeStepStatus,
  reviewActionPending,
  hasActiveReview,
  t,
}: TaskDetailAdvanceStateInput): { label: string; disabled: boolean } {
  if (taskNotStarted) {
    return {
      label: running ? t('taskDetail.starting') : t('taskList.start'),
      disabled: running,
    }
  }
  if (
    taskStatus === 'ready'
    && stepStates.length > 0
    && stepStates.every(
      (step) => step.status === 'passed' || step.status === 'skipped',
    )
  ) {
    return { label: t('taskDetail.workflowCompleted'), disabled: true }
  }
  if (activeStepStatus === 'awaiting_review') {
    return {
      label: t('taskDetail.approveAndAdvance'),
      disabled: reviewActionPending || !hasActiveReview,
    }
  }
  if (activeStepStatus === 'rejected') {
    return {
      label: t('taskDetail.forceApproveAndAdvance'),
      disabled: reviewActionPending || !hasActiveReview,
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
}

export function createOptimisticUserMessage(
  id: string,
  content: string,
  stepKey: string,
  createdAt: string,
): OptimisticUserMessage {
  return {
    id,
    role: 'user',
    content,
    step_key: stepKey,
    run_status: 'pending',
    created_at: createdAt,
    events: [],
  }
}

export function createOptimisticCoordinatorMessage(
  id: string,
  content: string,
  contextStepKey: string,
  createdAt: string,
): OptimisticCoordinatorMessage {
  return {
    ...createOptimisticUserMessage(id, content, contextStepKey, createdAt),
    channel: 'coordinator',
    context_step_key: contextStepKey,
  }
}

/** 把对话容器钉到底部所需的 scrollTop（不低于 0）。 */
export function conversationBottomScrollTop(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight)
}

/**
 * 观察消息内容包裹层的高度变化。
 *
 * overflow 容器的 border-box 高度是固定的（填满父级），ResizeObserver 观察
 * 容器本身不会因 scrollHeight 变化触发；必须观察其内容包裹层（高度 = 内容高度）。
 * 消息数据 effect 只覆盖消息新增/内容变化，而展开、折叠思考块（ProcessTrace 的
 * `<details>`）、过程追踪等纯 UI 状态变化不会改变消息数据却会改变内容高度，
 * 这类变化由本 helper 捕获，让调用方在跟随中重新钉底。
 *
 * 内容高度变化超过 1px 时回调一次；返回取消观察的 cleanup。
 */
export function observeContentResize({
  containerRef,
  contentRef,
  onResize,
}: {
  containerRef: { current: HTMLElement | null }
  contentRef: { current: HTMLElement | null }
  onResize: (info: { height: number; prevHeight: number }) => void
}): () => void {
  const container = containerRef.current
  const content = contentRef.current
  if (!container || !content || typeof ResizeObserver === 'undefined') {
    return () => { /* 无法观察时不挂监听 */ }
  }
  let prevHeight = container.scrollHeight
  const observer = new ResizeObserver(() => {
    const height = container.scrollHeight
    if (Math.abs(height - prevHeight) < 1) return
    const previous = prevHeight
    prevHeight = height
    onResize({ height, prevHeight: previous })
  })
  observer.observe(content)
  return () => observer.disconnect()
}
