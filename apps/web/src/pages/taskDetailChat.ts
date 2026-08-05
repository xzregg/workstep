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

export function isVisibleHistoryMessage(message: ConversationMessage): boolean {
  if (message.channel === 'review') return hasMessageContent(message.content)
  if (message.channel === 'coordinator') return true
  if (message.role === 'user' || message.role === 'system') return true
  return message.run_status === 'running' || hasMessageContent(message.content)
}

export function isVisibleLiveExecutionMessage(message: ConversationMessage): boolean {
  return message.channel === 'execution'
    && (message.status === 'running' || hasMessageContent(message.content))
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
    run_status: liveMessage.status || historyMessage.run_status,
    engine: liveMessage.engine || historyMessage.engine,
    model: liveMessage.model || historyMessage.model,
    created_at: liveMessage.created_at || historyMessage.created_at,
    prompt: resolveMessagePrompt(historyMessage.prompt, liveMessage.prompt),
  }
}

export function liveExecutionStatus(
  events: Array<{ type?: string; data?: Record<string, unknown> }>,
): string {
  const latest = [...events].reverse().find((event) => [
    'tool_use', 'tool_result', 'thinking_delta', 'status', 'message_started',
  ].includes(event.type || ''))
  if (latest?.type === 'tool_use') {
    const name = String(latest.data?.name || '工具')
    return `正在执行工具：${name}`
  }
  if (latest?.type === 'tool_result') return '工具执行完成，继续处理'
  if (latest?.type === 'thinking_delta') return '正在分析并生成结果'
  if (latest?.type === 'status' && latest.data?.status === 'initializing') {
    return '引擎初始化中'
  }
  return '引擎处理中'
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

export function stageAvatarText(label: string): string {
  const normalized = label.trim()
  return normalized.slice(0, 2) || '阶段'
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
