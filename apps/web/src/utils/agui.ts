/**
 * AG-UI 事件工具 — WorkStep WebSocket / 历史回放统一事件协议。
 *
 * 后端所有实时事件与历史 `events` 数组都翻译为 AG-UI 标准事件（见
 * ``engines/core/agui.py``），前端 store 只消费本模块描述的事件形状：
 * - 消息事件：``TEXT_MESSAGE_START / TEXT_MESSAGE_CHUNK / TEXT_MESSAGE_CONTENT /
 *   TEXT_MESSAGE_END``，``REASONING_MESSAGE_CHUNK``；
 * - 工具事件：``TOOL_CALL_START / TOOL_CALL_ARGS / TOOL_CALL_CHUNK /
 *   TOOL_CALL_RESULT``；
 * - 运行事件：``RUN_STARTED / RUN_FINISHED / RUN_ERROR``；
 * - 自定义事件：``CUSTOM``（``name`` 形如 ``workstep.*`` / ``a2ui.surface``）。
 *
 * 扩展字段（passthrough）：``task_id / step_key / channel / session_id /
 * engine / model / sequence / timestamp / created_at``。
 */

import type { AGUIEvent as CoreAGUIEvent } from '@ag-ui/core'
import type { EngineInputItem } from '../api/client.ts'

/** AG-UI 标准事件 + WorkStep passthrough 扩展字段（宽松形状）。 */
export interface AGUIEvent {
  type: string
  messageId?: string
  channel?: string
  session_id?: string
  task_id?: string
  step_key?: string
  engine?: string
  model?: string
  sequence?: number
  timestamp?: number
  created_at?: string
  /** 消息事件字段 */
  role?: 'user' | 'assistant' | 'developer' | 'system'
  delta?: string
  phase?: string
  source_item_id?: string
  content?: string
  prompt?: string
  status?: string
  error?: string
  ended_at?: string
  /** RUN_* 字段 */
  threadId?: string
  runId?: string
  /** TOOL_CALL_* 字段 */
  toolCallId?: string
  toolCallName?: string
  kind?: string
  args?: unknown
  output?: unknown
  isError?: boolean
  needsApproval?: boolean
  /** CUSTOM 字段 */
  name?: string
  value?: Record<string, unknown>
  [key: string]: unknown
}

/** 宽松事件形状：任何含 type/name/value 的对象都可参与 AG-UI 判定。 */
export type EventLike = {
  type?: string
  name?: string
  value?: Record<string, unknown>
  messageId?: string
  message_id?: string
  role?: string
  delta?: string
  phase?: string
  source_item_id?: string
  content?: string
  status?: string
  error?: string
  ended_at?: string
  prompt?: string
  toolCallId?: string
  tool_call_id?: string
  toolCallName?: string
  args?: unknown
  output?: unknown
  raw_output?: unknown
  raw_input?: unknown
  isError?: boolean
  needsApproval?: boolean
  session_id?: string
  task_id?: string
  step_key?: string
  engine?: string
  model?: string
  timestamp?: unknown
  created_at?: string
}

/** WorkStep 自定义事件名常量。 */
export const CUSTOM = {
  status: 'workstep.status',
  plan: 'workstep.plan',
  planUpdate: 'workstep.plan_update',
  goalUpdate: 'workstep.goal_update',
  planRemoved: 'workstep.plan_removed',
  usage: 'workstep.usage',
  sessionStarted: 'workstep.session_started',
  engineState: 'workstep.engine_state',
  subagent: 'workstep.subagent',
  compacted: 'workstep.compacted',
  error: 'workstep.error',
  acpRaw: 'workstep.acp_raw',
  interactionRequest: 'workstep.interaction_request',
  interactionResponse: 'workstep.interaction_response',
  asyncQuestion: 'workstep.async_question',
  actionProposal: 'workstep.action_proposal',
  flowProposals: 'workstep.flow_proposals',
  flowProposalsRejected: 'workstep.flow_proposals_rejected',
  taskDraft: 'workstep.task_draft',
  stepRetrying: 'workstep.step_retrying',
  stepRework: 'workstep.step_rework',
  runRecovered: 'workstep.run_recovered',
  reviewStatus: 'workstep.review_status',
  reviewResult: 'workstep.review_result',
  reviewContext: 'workstep.review_context',
  sessionInfoUpdate: 'workstep.session_info_update',
  availableCommandsUpdate: 'workstep.available_commands_update',
  configOptionUpdate: 'workstep.config_option_update',
  currentModeUpdate: 'workstep.current_mode_update',
  mcpMessage: 'workstep.mcp_message',
  elicitationCompleted: 'workstep.elicitation_completed',
  scheduledStart: 'workstep.scheduled_start',
  a2ui: 'a2ui.surface',
} as const

/** 是否为指定名称的 CUSTOM 事件。 */
export function isCustom(event: EventLike, name: string): boolean {
  return event.type === 'CUSTOM' && event.name === name
}

/** CUSTOM 事件载荷（缺省为空对象）。 */
export function customValue(event: EventLike): Record<string, unknown> {
  return event.value ?? {}
}

/** Convert an ACP available_commands_update payload into chat input items. */
export function availableCommandInputItems(
  value: Record<string, unknown>,
): EngineInputItem[] {
  const commands = value.available_commands ?? value.availableCommands
  if (!Array.isArray(commands)) return []
  return commands.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const command = raw as Record<string, unknown>
    const name = typeof command.name === 'string' ? command.name.trim() : ''
    if (!name) return []
    const input = command.input && typeof command.input === 'object'
      ? command.input as Record<string, unknown>
      : undefined
    const hint = typeof input?.hint === 'string'
      ? input.hint
      : typeof command.input_hint === 'string'
        ? command.input_hint
        : undefined
    return [{
      kind: 'command',
      name,
      description: typeof command.description === 'string' ? command.description : '',
      ...(hint ? { input_hint: hint } : {}),
      insert_text: `/${name} `,
      action: 'prompt',
    } satisfies EngineInputItem]
  })
}

/** 事件关联的消息 id（AG-UI 标准字段 messageId，兼容旧 snake_case）。 */
export function messageId(event: EventLike): string | undefined {
  return event.messageId ?? (event.message_id as string | undefined)
}

/** 消息内容增量：TEXT_MESSAGE_CHUNK 追加 delta，TEXT_MESSAGE_CONTENT 整段替换。 */
export function appendMessageContent(
  current: string,
  event: EventLike,
): string {
  if (isCommentaryEvent(event)) return current
  if (
    event.type === 'TEXT_MESSAGE_START'
    && typeof event.content === 'string'
  ) {
    return event.content
  }
  if (event.type === 'TEXT_MESSAGE_CHUNK') {
    return current + String(event.delta ?? '')
  }
  if (
    event.type === 'TEXT_MESSAGE_CONTENT'
    && typeof event.content === 'string'
  ) {
    return event.content
  }
  if (
    event.type === 'TEXT_MESSAGE_CONTENT'
    && typeof event.delta === 'string'
  ) {
    return event.delta
  }
  return current
}

/** Progress narration shares the process panel, but is not model reasoning. */
export function isCommentaryEvent(event: EventLike): boolean {
  return (event.type === 'TEXT_MESSAGE_CHUNK' || event.type === 'TEXT_MESSAGE_CONTENT')
    && event.phase === 'commentary'
}

/** 推理/思考块事件（AG-UI 用 REASONING_*，废弃 THINKING_*）。 */
export function isReasoningEvent(event: EventLike): boolean {
  return event.type === 'REASONING_MESSAGE_CHUNK'
}

/** 工具调用事件（start / args / chunk / result）。 */
export function isToolEvent(event: EventLike): boolean {
  return event.type === 'TOOL_CALL_START'
    || event.type === 'TOOL_CALL_ARGS'
    || event.type === 'TOOL_CALL_CHUNK'
    || event.type === 'TOOL_CALL_RESULT'
}

/** 工具调用 id（兼容 spec 的 toolCallId）。 */
export function toolCallId(event: EventLike): string {
  return String(event.toolCallId ?? event.tool_call_id ?? '')
}

/** 工具名称（spec 为 toolCallName，后端透传 name）。 */
export function toolName(event: EventLike): string {
  return String(event.toolCallName ?? event.name ?? 'tool')
}

/** 工具入参（TOOL_CALL_ARGS.args 或 TOOL_CALL_CHUNK.delta）。 */
export function toolArgs(event: EventLike): unknown {
  if (event.args !== undefined && event.args !== null) return event.args
  if (event.delta !== undefined && event.delta !== null) return event.delta
  return undefined
}

/** 工具结果（TOOL_CALL_RESULT.output）。 */
export function toolOutput(event: EventLike): unknown {
  if (event.output !== undefined && event.output !== null) return event.output
  if (event.raw_output !== undefined && event.raw_output !== null) {
    return event.raw_output
  }
  return undefined
}

/** 是否为运行生命周期状态事件（RUN_*）。 */
export function isRunEvent(event: EventLike): boolean {
  return event.type === 'RUN_STARTED'
    || event.type === 'RUN_FINISHED'
    || event.type === 'RUN_ERROR'
}

export type { CoreAGUIEvent }
