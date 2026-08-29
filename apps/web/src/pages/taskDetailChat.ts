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

interface MessageReview {
  id: string
  step_key: string
  status?: string
  mode?: string
  started_at?: string | null
}

function hasMessageContent(content: unknown): boolean {
  return typeof content === 'string' && content.trim().length > 0
}

const TERMINAL_EXECUTION_STATUSES = ['cancelled', 'stopped', 'failed']
const MESSAGE_RESUMABLE_STAGE_STATUSES = [
  'cancelled',
  'failed',
  'rejected',
  'awaiting_review',
]

export function isStageResumableWithMessage(status?: string): boolean {
  return status !== undefined && MESSAGE_RESUMABLE_STAGE_STATUSES.includes(status)
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
  return message.channel === 'execution'
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
    const sameDisplayedSecond = Math.floor(leftTime / 1000) === Math.floor(rightTime / 1000)
    if (isExecutionReviewPair && sameDisplayedSecond) {
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
  const latest = [...events].reverse().find((event) => [
    'tool_use', 'tool_result', 'thinking_delta', 'status', 'message_started', 'subagent',
    'TOOL_CALL_START', 'TOOL_CALL_RESULT', 'REASONING_MESSAGE_CHUNK',
    'RUN_STARTED', 'TEXT_MESSAGE_START',
  ].includes(event.type || '')
    || isCustom(event, CUSTOM.subagent)
    || isCustom(event, CUSTOM.status))
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

/** 把对话容器钉到底部所需的 scrollTop（不低于 0）。 */
export function conversationBottomScrollTop(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight)
}
