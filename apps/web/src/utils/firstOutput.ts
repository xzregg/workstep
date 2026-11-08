import { toMilliseconds } from './datetime'

/** First observable model output, including generated tool names/arguments. */
export function firstOutputTimestamp(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null
  const event = raw as Record<string, any>
  const data = event.data ?? {}
  if ((event.role ?? data.role) === 'user') return null
  let output: unknown
  switch (event.type) {
    case 'TEXT_MESSAGE_CHUNK':
    case 'REASONING_MESSAGE_CHUNK':
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'thinking_delta':
      output = event.delta ?? data.delta ?? data.text ?? data.content?.text
      break
    case 'TEXT_MESSAGE_CONTENT':
      output = event.content ?? event.delta ?? data.text
      break
    case 'TOOL_CALL_START':
    case 'TOOL_CALL_CHUNK':
      output = event.toolCallName || event.args || data.args
      break
    case 'TOOL_CALL_ARGS':
      output = event.delta ?? event.args ?? data.args
      break
    case 'tool_call':
      output = data.title || data.raw_input
      break
    default:
      return null
  }
  if (typeof output === 'string' ? output.length === 0 : !output || typeof output !== 'object' || Object.keys(output).length === 0) return null
  return toMilliseconds(event.timestamp ?? event.created_at)
}

/** Store this before live event trimming, so remounts never shift first output. */
export function preserveFirstOutput(
  summary: Record<string, unknown> | undefined | null,
  events: unknown[],
): Record<string, unknown> | undefined {
  if (toMilliseconds(summary?.first_output_at as string | number | undefined) !== null) return summary ?? undefined
  for (const event of events) {
    const at = firstOutputTimestamp(event)
    if (at !== null) return { ...summary, first_output_at: new Date(at).toISOString() }
  }
  return summary ?? undefined
}
