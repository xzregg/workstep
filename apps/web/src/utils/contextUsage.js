export function usageFromEvents(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (
      (event?.type === 'usage' || event?.type === 'usage_update')
      && event.data && typeof event.data === 'object'
    ) {
      return event.data
    }
    if (
      event?.type === 'CUSTOM'
      && event?.name === 'workstep.usage'
      && event?.value && typeof event.value === 'object'
    ) {
      return event.value
    }
  }
  return null
}

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

export function contextUsageFromMessages(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const usage = usageFromEvents(messages[index]?.events || [])
    if (!usage || Object.keys(usage).length === 0) continue

    const reportedUsed = number(usage.used)
    const reportedTotal = number(usage.total_tokens ?? usage.tokens)
    const input = number(usage.input_tokens ?? usage.prompt_tokens)
    const output = number(usage.output_tokens ?? usage.completion_tokens)
    const used = reportedUsed || reportedTotal || input + output
    if (used <= 0) continue

    const reportedSize = number(
      usage.size
      ?? usage.model_context_window
      ?? usage.context_window
      ?? usage.modelContextWindow
      ?? usage.contextWindow,
    )
    if (reportedSize <= 0) continue
    const total = reportedSize
    return {
      used,
      total,
      percent: Math.min(100, (used / total) * 100),
    }
  }
  return null
}

function eventText(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return String(value)
}

function stringify(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

function isCjk(code) {
  return (
    (code >= 0x4e00 && code <= 0x9fff)   // CJK Unified
    || (code >= 0x3400 && code <= 0x4dbf) // CJK Extension A
    || (code >= 0x3040 && code <= 0x30ff) // Japanese kana
    || (code >= 0xac00 && code <= 0xd7af) // Korean
    || (code >= 0xf900 && code <= 0xfaff) // CJK Compatibility
  )
}

/**
 * 字符数 → token 估算：CJK ≈ 1 token/字符，ASCII/其他 ≈ 1 token/4 字符。
 * 与 messageTimeline.ts 的 estimateTokens 同一口径，仅用于流式实时估算，
 * 引擎上报 usage_update 后以真实数据为准。
 */
export function estimateTokens(text) {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code !== undefined && isCjk(code)) {
      cjk += 1
    } else {
      other += 1
    }
  }
  return Math.max(1, Math.round(cjk + other / 4))
}

/**
 * LLM 尚未结束（无 usage_update 事件）时，按已接收的事件与字符数量换算
 * token 统计：assistant 文本/思考/工具结果计为输出，用户输入/工具入参计为输入。
 * 返回的 usage 带 estimated: true，前端展示为估算值。
 */
export function estimateUsageFromEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return null
  let outputText = ''
  let inputText = ''
  let sawAssistantChunk = false
  let sawUserChunk = false
  const fullArgsSeen = new Set()

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const type = event.type
    const data = (event.data && typeof event.data === 'object') ? event.data : {}
    const isUser = event.role === 'user' || data.role === 'user'
    const contentText = data.content && typeof data.content === 'object'
      ? data.content.text
      : undefined

    if (
      type === 'TEXT_MESSAGE_CHUNK'
      || type === 'agent_message_chunk'
      || type === 'user_message_chunk'
    ) {
      const text = eventText(event.delta ?? data.delta ?? data.text ?? contentText)
      if (!text) continue
      if (type === 'user_message_chunk' || isUser) {
        inputText += text
        sawUserChunk = true
      } else {
        outputText += text
        sawAssistantChunk = true
      }
      continue
    }

    if (type === 'TEXT_MESSAGE_CONTENT') {
      const text = eventText(event.content ?? event.delta ?? data.content ?? data.text)
      if (!text) continue
      if (isUser) {
        if (!sawUserChunk) inputText += text
      } else if (!sawAssistantChunk) {
        outputText += text
      }
      continue
    }

    if (
      type === 'REASONING_MESSAGE_CHUNK'
      || type === 'agent_thought_chunk'
      || type === 'thinking_delta'
    ) {
      const text = eventText(event.delta ?? data.delta ?? data.text ?? contentText)
      if (text) outputText += text
      continue
    }

    if (type === 'TOOL_CALL_ARGS' || type === 'tool_call') {
      const id = event.toolCallId ?? event.tool_call_id ?? data.tool_call_id ?? ''
      if (fullArgsSeen.has(id)) continue
      const raw = type === 'TOOL_CALL_ARGS'
        ? (event.args ?? data.args)
        : data.raw_input
      if (raw !== undefined && raw !== null) {
        inputText += stringify(raw)
        fullArgsSeen.add(id)
      }
      continue
    }

    if (type === 'TOOL_CALL_CHUNK') {
      const id = event.toolCallId ?? event.tool_call_id ?? data.tool_call_id ?? ''
      // 已有完整入参（TOOL_CALL_ARGS）时跳过增量分片，避免重复计数。
      if (fullArgsSeen.has(id)) continue
      const delta = eventText(event.delta ?? data.delta)
      if (delta) inputText += delta
      continue
    }

    if (type === 'TOOL_CALL_RESULT' || type === 'tool_call_update') {
      const raw = type === 'TOOL_CALL_RESULT'
        ? (event.output ?? event.raw_output ?? data.output ?? data.raw_output)
        : data.raw_output
      if (raw !== undefined && raw !== null) {
        outputText += stringify(raw)
      }
    }
  }

  const inputTokens = estimateTokens(inputText)
  const outputTokens = estimateTokens(outputText)
  if (inputTokens <= 0 && outputTokens <= 0) return null
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    estimated: true,
  }
}
