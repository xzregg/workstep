import { toMilliseconds } from '../utils/datetime'
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
  content?: unknown
  run_status?: string
  status?: string
  events?: Array<{ type?: string; data?: Record<string, unknown> }>
  prompt?: string | null
  created_at?: string
}

function hasMessageContent(content: unknown): boolean {
  return typeof content === 'string' && content.trim().length > 0
}

const TERMINAL_EXECUTION_STATUSES = ['cancelled', 'stopped', 'failed']

export function isVisibleHistoryMessage(message: ConversationMessage): boolean {
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
    events: Array.isArray(liveMessage.events) && liveMessage.events.length > 0
      ? liveMessage.events
      : historyMessage.events,
    // 实时插入的用户消息不带完成事件（引擎只发 live_message 确认），
    // 保持乐观消息的 completed，避免右侧用户消息被误标为 streaming。
    run_status: liveMessage.role === 'user'
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
 * `sequence` is kept as a tiebreaker for same-instant messages.
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
  events: Array<{ type?: string; data?: Record<string, unknown> }>,
  t: TFunction = zhCNT,
): string {
  const latest = [...events].reverse().find((event) => [
    'tool_use', 'tool_result', 'thinking_delta', 'status', 'message_started',
  ].includes(event.type || ''))
  if (latest?.type === 'tool_use') {
    const name = String(latest.data?.name || t('chat.tool'))
    return t('chat.toolRunning', { name })
  }
  if (latest?.type === 'tool_result') return t('chat.toolDone')
  if (latest?.type === 'thinking_delta') return t('chat.thinking')
  if (latest?.type === 'status' && latest.data?.status === 'initializing') {
    return t('chat.engineInitializing')
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
