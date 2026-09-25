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

interface DispatchedTaskCandidate {
  id: string
  source_task_id?: string | null
  source_step_key?: string | null
  created_at?: string | null
}

export function findLatestDispatchedTask<T extends DispatchedTaskCandidate>(
  tasks: T[],
  sourceTaskId: string,
  sourceStepKey: string,
): T | undefined {
  return tasks
    .filter((task) => (
      task.source_task_id === sourceTaskId
      && task.source_step_key === sourceStepKey
    ))
    .sort((left, right) => (
      toMilliseconds(right.created_at) ?? 0
    ) - (
      toMilliseconds(left.created_at) ?? 0
    ))[0]
}

interface ConversationMessage {
  id?: string
  channel?: string
  role?: string
  step_key?: string
  artifact_round?: number | null
  content?: unknown
  run_status?: string
  status?: string
  events?: Array<{ type?: string; data?: Record<string, unknown> }>
  event_detail?: { event_count?: number }
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

export function messageSessionId(
  message: { session_id?: string | null; run_status?: string },
  isReview: boolean,
  stepSessionId?: string | null,
): string | null {
  return message.session_id
    || (!isReview && message.run_status === 'running' ? stepSessionId || null : null)
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
 * 这类错误可以用同一个步骤提示词重新建会话重跑，不需要用户重写上下文。
 */
export function isLostEngineSessionError(error?: string | null): boolean {
  if (!error) return false
  return LOST_ENGINE_SESSION_PATTERNS.some((pattern) => pattern.test(error))
}

const TERMINAL_EXECUTION_STATUSES = ['cancelled', 'stopped', 'failed']
// 步骤正在执行时只能实时注入，不能按「带消息重跑」处理。
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
 * 是否可以把消息发给某个步骤并（重新）执行它。
 *
 * 规则：只要该步骤执行过一次（不管成功还是失败），就允许 @。
 * 执行中的步骤不接受重跑（走实时注入），从未执行过的 `pending` 步骤也不允许。
 */
export function isStepResumableWithMessage(
  status?: string,
  hasHistory?: boolean,
): boolean {
  if (status !== undefined && ACTIVE_STAGE_STATUSES.includes(status)) return false
  if (status !== undefined && MESSAGE_RESUMABLE_STAGE_STATUSES.includes(status)) {
    return true
  }
  return hasHistory === true
}

export function isSelectedStepRunning(
  target: string,
  runningStepKeys: readonly string[],
): boolean {
  return target !== 'coordinator' && runningStepKeys.includes(target)
}

export function isStepActiveForStop(status?: string): boolean {
  return status === 'running' || status === 'reviewing'
}

export function resolveTaskChatTarget(
  current: string | 'coordinator',
  runningStepKeys: readonly string[],
  resumableStepKeys: readonly string[],
): string | 'coordinator' {
  if (current !== 'coordinator') {
    if (
      runningStepKeys.includes(current)
      || resumableStepKeys.includes(current)
    ) {
      return current
    }
  }
  if (current === 'coordinator') return 'coordinator'
  return runningStepKeys[0] ?? resumableStepKeys[0] ?? 'coordinator'
}

export function taskTargetStepsInWorkflowOrder<T extends { key: string }>(
  steps: readonly T[],
  runningStepKeys: readonly string[],
  resumableStepKeys: readonly string[],
): T[] {
  const available = new Set([...runningStepKeys, ...resumableStepKeys])
  return steps.filter((step) => available.has(step.key))
}

const RESTART_IMPACT_ACTIVE_STATUSES = new Set([
  'running',
  'reviewing',
  'awaiting_review',
  'retrying',
  'rework',
  'rework_waiting',
])

/** Explain which active steps stop, restart, or leave scope after a restart. */
export function resolveStepRestartImpact<
  T extends { key: string; dependsOn?: readonly string[] },
>(
  steps: readonly T[],
  progress: readonly { step_key?: string; status?: string }[],
  targetStepKey: string,
): { interrupted: T[]; restarted: T[]; cancelled: T[] } {
  const executionScope = new Set<string>([targetStepKey])
  let changed = true
  while (changed) {
    changed = false
    for (const step of steps) {
      if (executionScope.has(step.key)) continue
      if ((step.dependsOn ?? []).some((dependency) => (
        executionScope.has(dependency)
      ))) {
        executionScope.add(step.key)
        changed = true
      }
    }
  }
  const statusByStep = new Map(
    progress.map((item) => [item.step_key, item.status]),
  )
  const interrupted = steps.filter((step) => (
    RESTART_IMPACT_ACTIVE_STATUSES.has(statusByStep.get(step.key) ?? '')
  ))
  return {
    interrupted,
    restarted: interrupted.filter((step) => executionScope.has(step.key)),
    cancelled: interrupted.filter((step) => !executionScope.has(step.key)),
  }
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

  const stepReviews = reviews.filter((review) => review.step_key === message.step_key)
  return stepReviews.length === 1 ? stepReviews[0] : undefined
}

export function isMessageReviewActionable<T extends MessageReview>(
  message: ConversationMessage,
  reviews: readonly T[],
  stepStatus?: string,
): boolean {
  const review = resolveMessageReview(message, reviews)
  return isReviewActionable(review, reviews, stepStatus)
}

export function isReviewActionable<T extends MessageReview>(
  review: T | undefined,
  reviews: readonly T[],
  stepStatus?: string,
): boolean {
  if (stepStatus !== 'awaiting_review') return false
  if (!review || (review.status !== 'pending' && review.status !== 'rejected')) {
    return false
  }
  const stepReviews = reviews.filter((item) => item.step_key === review.step_key)
  const latest = stepReviews.reduce<T | undefined>((current, item) => {
    if (!current) return item
    const currentTime = toMilliseconds(current.started_at) ?? Number.NEGATIVE_INFINITY
    const itemTime = toMilliseconds(item.started_at) ?? Number.NEGATIVE_INFINITY
    return itemTime > currentTime ? item : current
  }, undefined)
  return latest?.id === review.id
}

export function canCompleteStoppedReview<T extends MessageReview & {
  workflow_run_id: string
  artifact_round: number | null
  error?: string | null
}>(
  review: T | undefined,
  reviews: readonly T[],
  artifacts: readonly { step_key: string; round: number }[],
  taskStatus?: string,
  activeRunId?: string | null,
  stepStatus?: string,
): boolean {
  const stoppedManual = review?.mode === 'manual'
    && review.status === 'terminated'
  const stoppedAuto = review?.mode === 'auto'
    && review.status === 'failed' && review.error === '手动停止'
  if (!review || (!stoppedManual && !stoppedAuto)
    || !['stopped', 'paused'].includes(taskStatus || '')
    || !['cancelled', 'failed', 'pending'].includes(stepStatus || '')
    || !activeRunId
    || !review.artifact_round
    || !artifacts.some((artifact) => artifact.step_key === review.step_key
      && artifact.round === review.artifact_round)) return false
  return reviews.some((item) => item.id === review.id)
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
  if (message.channel === 'review') {
    return hasMessageContent(message.content)
      || (message.run_status === 'succeeded' && (message.event_detail?.event_count ?? 0) > 0)
  }
  if (message.channel === 'coordinator') return true
  if (message.role === 'user' || message.role === 'system') return true
  // 已停止/失败但无内容的执行消息也要保留展示（附带「已停止/失败」状态徽标），
  // 不能因为没产出内容就从对话里消失。
  return message.run_status === 'running'
    || TERMINAL_EXECUTION_STATUSES.includes(message.run_status || '')
    || hasMessageContent(message.content)
}

export function isVisibleLiveExecutionMessage(message: ConversationMessage): boolean {
  // 实时插入的用户消息由乐观/历史渲染呈现（右侧 + @步骤名），
  // 不应再以左侧执行消息的身份出现。
  if (message.role === 'user') return false
  return (message.channel === 'execution' || message.channel === 'review')
    && (message.status === 'running'
      || TERMINAL_EXECUTION_STATUSES.includes(message.status || '')
      || hasMessageContent(message.content))
}

export function canRetryFailedExecutionMessage(
  message: Pick<ConversationMessage, 'id' | 'role' | 'channel' | 'run_status'>,
  latestMessageId: string | undefined,
  stepStatus: string | undefined,
  stepError: string | null | undefined,
): boolean {
  return message.id === latestMessageId
    && message.role === 'assistant'
    && message.channel === 'execution'
    && message.run_status === 'failed'
    && stepStatus === 'failed'
    && Boolean(stepError?.trim())
}

export function canRestartStoppedExecutionMessage(
  message: Pick<ConversationMessage, 'id' | 'role' | 'channel' | 'run_status'>,
  latestMessageId: string | undefined,
  taskStatus: string | undefined,
  stepStatus: string | undefined,
): boolean {
  return message.id === latestMessageId
    && message.role === 'assistant'
    && message.channel === 'execution'
    && ['cancelled', 'stopped'].includes(message.run_status || '')
    && ['paused', 'stopped'].includes(taskStatus || '')
    && ['failed', 'pending', 'cancelled'].includes(stepStatus || '')
}

export function latestMessageIdsByStep(
  messages: readonly { id?: string; step_key?: string; context_step_key?: string }[],
): Map<string, string> {
  const latest = new Map<string, string>()
  for (const message of messages) {
    const stepKey = message.context_step_key || message.step_key
    if (stepKey && message.id) latest.set(stepKey, message.id)
  }
  return latest
}

export function latestExecutionMessageIdsByStep(
  messages: readonly { id?: string; step_key?: string; channel?: string; role?: string }[],
): Map<string, string> {
  const latest = new Map<string, string>()
  for (const message of messages) {
    if (message.channel === 'execution' && message.role === 'assistant'
      && message.step_key && message.id) {
      latest.set(message.step_key, message.id)
    }
  }
  return latest
}

export function failedExecutionCompletionRound(
  message: Pick<ConversationMessage, 'id' | 'role' | 'channel' | 'run_status' | 'step_key' | 'artifact_round'>,
  artifacts: readonly { step_key: string; round: number }[],
  latestMessageId: string | undefined,
  taskStatus: string | undefined,
  stepStatus: string | undefined,
): number | null {
  if (message.id !== latestMessageId
    || message.role !== 'assistant' || message.channel !== 'execution'
    || !['failed', 'cancelled', 'stopped'].includes(message.run_status || '')
    || !['paused', 'stopped'].includes(taskStatus || '')
    || !['failed', 'pending', 'cancelled'].includes(stepStatus || '')) return null
  const rounds = artifacts.filter((artifact) => artifact.step_key === message.step_key)
    .map((artifact) => artifact.round)
  if (rounds.length === 0) return null
  return message.artifact_round && rounds.includes(message.artifact_round)
    ? message.artifact_round : Math.max(...rounds)
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
  const restarted = liveMessage.restarted === true
  return {
    ...historyMessage,
    content: restarted
      ? liveMessage.content
      : hasMessageContent(liveMessage.content)
      ? liveMessage.content
      : historyMessage.content,
    events: restarted && historyMessage.run_status === 'failed'
      ? liveMessage.events
      : mergePlanEvents(
      historyMessage.events,
      mergeInteractionEvents(historyMessage.events, liveMessage.events),
    ),
    // Persisted terminal status wins over a stale live "running" update.
    // Inserted user messages also have no completion event after their ack.
    run_status: liveMessage.role === 'user' || historyMessage.role === 'user'
      || (!restarted && historyMessage.run_status && !['running', 'queued'].includes(historyMessage.run_status))
      ? historyMessage.run_status
      : liveMessage.status || historyMessage.run_status,
    engine: liveMessage.engine || historyMessage.engine,
    model: liveMessage.model || historyMessage.model,
    created_at: restarted
      ? historyMessage.created_at
      : liveMessage.created_at || historyMessage.created_at,
    started_at: restarted
      ? liveMessage.started_at || historyMessage.started_at
      : historyMessage.started_at,
    prompt: resolveMessagePrompt(historyMessage.prompt, liveMessage.prompt),
  }
}

export function runningTaskMessageIds(
  historyMessages: Array<Record<string, any>>,
  liveMessages: Record<string, Record<string, any>>,
  targetStepKey: string | null,
): { coordinator?: string; execution?: string; review?: string } {
  const messages = new Map<string, Record<string, any>>()
  for (const message of historyMessages) {
    messages.set(String(message.id), mergeHistoryMessageWithLive(
      message, liveMessages[String(message.id)],
    ))
  }
  for (const message of Object.values(liveMessages)) {
    if (!messages.has(String(message.id))) messages.set(String(message.id), message)
  }
  const running = [...messages.values()].filter((message) => (
    message.role !== 'user'
    && ['queued', 'running'].includes(message.run_status || message.status || '')
  ))
  const latest = (channel: string, stepKey?: string | null) => [...running].reverse().find(
    (message) => message.channel === channel
      && (stepKey == null || (message.context_step_key || message.step_key) === stepKey),
  )?.id as string | undefined
  return {
    coordinator: latest('coordinator'),
    execution: targetStepKey == null ? undefined : latest('execution', targetStepKey),
    review: targetStepKey == null ? undefined : latest('review', targetStepKey),
  }
}

/**
 * Persisted messages follow their task-local creation sequence. Live messages
 * without a sequence are inserted by their displayed start time. Completion
 * time affects duration and status, not the position of an existing bubble.
 */
export function orderConversationMessages(
  messages: Array<Record<string, any>>,
): Array<Record<string, any>> {
  const startTime = (message: Record<string, any>) => (
    toMilliseconds(message.started_at ?? message.created_at) ?? 0
  )
  const ordered = messages
    .filter((message) => typeof message.sequence === 'number')
    .sort((left, right) => left.sequence - right.sequence)
  const live = messages
    .filter((message) => typeof message.sequence !== 'number')
    .sort((left, right) => {
      const delta = startTime(left) - startTime(right)
      if (delta !== 0) return delta
      if (left.reply_to_message_id === right.id) return 1
      if (right.reply_to_message_id === left.id) return -1
      return 0
    })
  for (const message of live) {
    const time = startTime(message)
    const nextPersisted = ordered.findIndex((existing) => (
      typeof existing.sequence === 'number' && startTime(existing) > time
    ))
    let index = nextPersisted < 0 ? ordered.length : nextPersisted
    const parentIndex = message.reply_to_message_id
      ? ordered.findIndex((existing) => existing.id === message.reply_to_message_id)
      : -1
    if (parentIndex >= index) index = parentIndex + 1
    ordered.splice(index, 0, message)
  }
  return ordered
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
    // 否则本轮回复已完成，步骤正在收尾，直接显示处理中。
    return hasPendingInserts ? t('chat.waitingInjection') : t('chat.processing')
  }
  return t('chat.processing')
}

interface TaskComposerStateInput {
  target: 'coordinator' | 'step'
  stepRunning?: boolean
  stepResuming?: boolean
  coordinatorRunning?: boolean
  prompt?: string
}

/** Keep the step insert/send state and the stop-button state on one condition. */
export function resolveTaskComposerState({
  target,
  stepRunning = false,
  stepResuming = false,
  coordinatorRunning = false,
  prompt = '',
}: TaskComposerStateInput): { disabled: boolean; running: boolean } {
  if (target === 'coordinator') {
    return { disabled: false, running: coordinatorRunning }
  }
  if (stepResuming) return { disabled: true, running: true }
  return {
    disabled: false,
    running: stepRunning && prompt.trim().length === 0,
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

export function stepAvatarText(label: string, t: TFunction = zhCNT): string {
  const normalized = label.trim()
  return normalized.slice(0, 2) || t('chat.stepFallback')
}

export function isTaskNotStarted(steps: TaskStepStartState[]): boolean {
  return steps.length > 0 && steps.every((step) =>
    step.started_at === null
    && (step.status === 'pending' || step.status === 'skipped')
  )
}

export function resolveStepDisplayStatus(
  status: string,
  previousStatus?: string | null,
): string {
  return status === 'pending' && previousStatus
    ? previousStatus
    : status
}

const ACTIVE_STAGE_PROGRESS_STATUSES = new Set([
  'running',
  'reviewing',
  'awaiting_review',
  'retrying',
  'rework',
  'rework_waiting',
])

export function findActiveStepIndex(
  statuses: readonly string[],
  taskStatus?: string | null,
): number {
  const active = statuses.findIndex((status) => ACTIVE_STAGE_PROGRESS_STATUSES.has(status))
  if (active >= 0) return active
  const failed = statuses.findIndex((status) => status === 'failed')
  if (failed >= 0) return failed
  return taskStatus === 'running'
    ? statuses.findIndex((status) => status === 'pending')
    : -1
}

interface PendingReviewCandidate {
  id: string
  step_key: string
  status: string
  started_at?: string | null
}

interface ReviewStepState {
  step_key?: string
  status?: string
}

/**
 * 移动端审核入口只代表“当前可操作的审核”，不能被历史 pending 记录触发。
 */
export function findActionablePendingReview<T extends PendingReviewCandidate>(
  reviews: readonly T[],
  steps: readonly ReviewStepState[],
): T | undefined {
  for (const step of steps) {
    if (!step.step_key || step.status !== 'awaiting_review') continue
    const stepReviews = reviews.filter((review) => review.step_key === step.step_key)
    const latest = stepReviews.reduce<T | undefined>((current, review) => {
      if (!current) return review
      const currentTime = toMilliseconds(current.started_at) ?? Number.NEGATIVE_INFINITY
      const reviewTime = toMilliseconds(review.started_at) ?? Number.NEGATIVE_INFINITY
      return reviewTime > currentTime ? review : current
    }, undefined)
    if (latest?.status === 'pending') return latest
  }
  return undefined
}

export function isTaskCompleted(steps: TaskStepStartState[]): boolean {
  return steps.length > 0
    && !isTaskNotStarted(steps)
    && steps.every((step) => step.status === 'passed' || step.status === 'skipped')
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

