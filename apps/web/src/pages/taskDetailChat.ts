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
import { collapseDirectoryArtifactChildren } from '../utils/artifactListing'

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

export interface ArtifactRoundChoice {
  step_key: string
  round: number
  is_latest: boolean
  is_selected: boolean
  logical_name?: string | null
  name: string
}

export function artifactsForStepRoundOutputs<
  T extends ArtifactRoundChoice & {
    declared_output?: boolean
    logical_name?: string | null
    path?: string
    is_dir?: boolean
  },
>(
  artifacts: readonly T[],
  stepKey: string,
  round: number | undefined,
): T[] {
  if (round === undefined) return []
  const matching = artifacts.filter((artifact) => (
    artifact.step_key === stepKey && artifact.round === round
  ))
  const collapsed = collapseDirectoryArtifactChildren(matching)
  const preferred = collapsed.filter((artifact) => (
    artifact.is_dir || artifact.declared_output === true
  ))
  if (preferred.length > 0) return preferred
  return collapsed.filter((artifact) => (
    artifact.declared_output !== false && Boolean(artifact.logical_name)
  ))
}

export function groupStepOutputsByInput<
  T extends { name: string; logical_name?: string | null; artifact_type?: string | null; is_dir?: boolean; output_port?: number | null },
>(
  inputs: readonly { outputs?: readonly { name: string; type: string }[] }[],
  outputs: readonly { name: string; type: string }[],
  produced: readonly T[],
) {
  const groups: Array<Array<{ name: string; type: string; outputIndex: number; artifact?: T }>> =
    inputs.map(() => [])
  const hasNestedOutputs = inputs.some((input) => input.outputs?.length)
  let outputIndex = 0
  inputs.forEach((input, inputIndex) => {
    const declared = hasNestedOutputs ? input.outputs || [] : inputIndex === 0 ? outputs : []
    declared.forEach((output) => {
      groups[inputIndex].push({ ...output, outputIndex: outputIndex++ })
    })
  })
  if (!produced.length) return groups

  const available = groups.flatMap((group, inputIndex) =>
    group.map((output) => ({ output, inputIndex })))
  const result = inputs.map(() => [] as typeof groups[number])
  produced.forEach((artifact) => {
    const name = artifact.logical_name || artifact.name
    const portMatchIndex = artifact.output_port == null ? -1 :
      available.findIndex(({ output }) => output.outputIndex === artifact.output_port)
    const matchIndex = portMatchIndex >= 0 ? portMatchIndex :
      available.findIndex(({ output }) => output.name === name)
    const match = matchIndex >= 0 ? available.splice(matchIndex, 1)[0] : undefined
    const inputIndex = match?.inputIndex ?? 0
    result[inputIndex].push({
      name,
      type: artifact.artifact_type || (artifact.is_dir ? 'directory' : 'file'),
      outputIndex: match?.output.outputIndex ?? -1,
      artifact,
    })
  })
  return result
}

export function downstreamInputsForOutput(
  steps: readonly {
    key: string
    nodeId?: string | number
    label: string
    inputs: readonly { name: string }[]
  }[],
  connections: readonly {
    from: string | number
    fromPort?: number
    to: string | number
    toPort?: number
    kind?: string
  }[],
  sourceStepKey: string,
  outputPort: number,
): Array<{ stepKey: string; stepLabel: string; inputName: string }> {
  const source = steps.find((step) => step.key === sourceStepKey)
  if (!source) return []
  const byNodeId = new Map(steps.map((step) => [String(step.nodeId ?? step.key), step]))
  const sourceNodeId = String(source.nodeId ?? source.key)
  const targets: Array<{ stepKey: string; stepLabel: string; inputName: string }> = []
  const seen = new Set<string>()
  for (const connection of connections) {
    if (connection.kind === 'dashed'
      || String(connection.from) !== sourceNodeId
      || (connection.fromPort ?? 0) !== outputPort) continue
    const target = byNodeId.get(String(connection.to))
    const input = target?.inputs[connection.toPort ?? 0]
    if (!target || !input) continue
    const id = `${target.key}:${connection.toPort ?? 0}`
    if (seen.has(id)) continue
    seen.add(id)
    targets.push({ stepKey: target.key, stepLabel: target.label, inputName: input.name })
  }
  return targets
}

interface StepRoundInputSnapshotChoice {
  step_key: string
  round: number
  ports: Array<{
    port: number
    name?: string
    status?: string
    sources: Array<{ step: string; round: number; path: string; name: string }>
  }>
}

export function findStepRoundInputPort(
  snapshots: readonly StepRoundInputSnapshotChoice[],
  stepKey: string,
  stepRound: number | undefined,
  inputPort: number,
) {
  if (stepRound === undefined) return undefined
  return snapshots.find((item) => (
    item.step_key === stepKey && item.round === stepRound
  ))?.ports.find((port) => port.port === inputPort)
}

export function findStepRoundInputArtifact<
  T extends ArtifactRoundChoice & { path: string },
>(
  artifacts: readonly T[],
  snapshots: readonly StepRoundInputSnapshotChoice[],
  stepKey: string,
  stepRound: number | undefined,
  inputPort: number,
): T | undefined {
  const source = findStepRoundInputPort(
    snapshots,
    stepKey,
    stepRound,
    inputPort,
  )?.sources[0]
  if (!source) return undefined
  return artifacts.find((artifact) => artifact.path === source.path)
    ?? artifacts.find((artifact) => (
      artifact.step_key === source.step
      && artifact.round === source.round
      && (artifact.logical_name === source.name || artifact.name === source.name)
    ))
}

interface StepIoContractChoice {
  key: string
  inputs?: Array<{ name?: string; type?: string; outputs?: Array<{ name?: string; type?: string }> }>
  outputs?: Array<{ name?: string; type?: string }>
}

function normalizedIoContract(step: StepIoContractChoice | Record<string, any>) {
  const inputs = Array.isArray(step.inputs) ? step.inputs : []
  const outputs = Array.isArray(step.outputs)
    ? step.outputs
    : (Array.isArray(inputs[0]?.outputs) ? inputs[0].outputs : [])
  const normalizePorts = (ports: Array<{ name?: string; type?: string }>) => (
    ports.map((port) => ({
      name: String(port?.name ?? '').trim(),
      type: String(port?.type ?? 'any').trim().toLocaleLowerCase(),
    }))
  )
  return {
    inputs: normalizePorts(inputs),
    outputs: normalizePorts(outputs),
  }
}

export function hasStepIoContractChanged(
  currentStep: StepIoContractChoice,
  executedContract: any,
): boolean {
  if (!executedContract || typeof executedContract !== 'object') return false
  return JSON.stringify(normalizedIoContract(currentStep))
    !== JSON.stringify(normalizedIoContract(executedContract))
}

export function findPreferredArtifact<
  T extends ArtifactRoundChoice & { path?: string },
>(
  artifacts: readonly T[],
  name: string,
  preferredStepKey?: string,
  preferredRound?: number,
  preferredPath?: string,
): T | undefined {
  const normalize = (value: string) =>
    value.toLocaleLowerCase().replace(/[\s_.-]/g, '')
  const normalizedName = normalize(name)
  const candidates = preferredStepKey
    ? artifacts.filter((artifact) => artifact.step_key === preferredStepKey)
    : artifacts
  const roundCandidates = preferredRound === undefined
    ? candidates
    : candidates.filter((artifact) => artifact.round === preferredRound)
  const preferred = roundCandidates.filter((artifact) => artifact.is_selected)
  const latest = roundCandidates.filter((artifact) => artifact.is_latest)
  const ordered = [...preferred, ...latest, ...roundCandidates]
  return (
    (preferredPath
      ? ordered.find((artifact) => artifact.path === preferredPath)
      : undefined) ||
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

export function artifactsForMessage<
  T extends ArtifactRoundChoice & { path?: string; is_dir?: boolean },
>(
  artifacts: readonly T[],
  stepKey: string,
  artifactRound?: number | null,
): T[] {
  if (!artifactRound) return []
  return collapseDirectoryArtifactChildren(artifacts.filter((artifact) => (
    artifact.step_key === stepKey && artifact.round === artifactRound
  )))
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
  // 实时插入的用户消息由乐观/历史渲染呈现（右侧 + @步骤名），
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
 * - finished step messages sort by `ended_at` (完成/中断时间);
 * - still-running step messages sort by `now` (创建时间 + 已进行时长), so any
 *   step output that is still going (or finished) after the user's message
 *   lands below the inserted user message instead of above it;
 * - user messages anchor by their send time (`created_at`).
 * Review and execution messages in the same displayed second use `sequence`,
 * so the review stays after the step output it reviews without faking time.
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
      return Math.max(now, toMilliseconds(message.created_at) ?? 0)
    }
    if (message.role === 'user') {
      return toMilliseconds(message.created_at) ?? 0
    }
    return toMilliseconds(message.ended_at)
      ?? toMilliseconds(message.created_at)
      ?? 0
  }
  return [...messages].sort((left, right) => {
    // 回复与被回复消息是明确的因果关系，优先级高于时间戳。协调助手的
    // user/assistant 消息会在同一数据库工作单元里使用相同 created_at；
    // 实时刷新期间也可能暂时缺少 sequence，因此不能依赖稳定排序碰运气。
    if (left.reply_to_message_id === right.id) return 1
    if (right.reply_to_message_id === left.id) return -1
    const leftTime = effectiveTime(left)
    const rightTime = effectiveTime(right)
    const leftStep = left.context_step_key || left.step_key
    const rightStep = right.context_step_key || right.step_key
    const isExecutionReviewPair = leftStep === rightStep
      && left.role !== 'user'
      && right.role !== 'user'
      && ((left.channel === 'execution' && right.channel === 'review')
        || (left.channel === 'review' && right.channel === 'execution'))
    // 同一步骤的执行与审核消息始终按服务端 sequence 排列：执行消息的
    // ended_at 可能在整个步骤（含审核）收尾时才写入，晚于审核的 ended_at，
    // 只按时间排会把审核顶到步骤输出上方。
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
    // 否则本轮回复已完成，步骤正在收尾，直接显示处理中。
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
 * 用户滚轮/键盘上滚在 capture 步骤已先行取消跟随，因此不会在此被保留。
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
