import { isToolEvent } from './agui'
import { toMilliseconds, type DateTimeValue } from './datetime'

const OUTPUT_TYPES = new Set([
  'TEXT_MESSAGE_CHUNK', 'REASONING_MESSAGE_CHUNK',
  'agent_message_chunk', 'agent_thought_chunk', 'thinking_delta',
])
const BOUNDARY_TYPES = new Set([
  'tool_call', 'tool_call_update', 'tool_use', 'interaction_request',
  'RUN_FINISHED', 'RUN_ERROR',
])

// Quarter-token units avoid rounding each tiny streaming chunk up to one token.
function tokenUnits(text: string): number {
  let units = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    units += (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0x3400 && code <= 0x4dbf)
      || (code >= 0x3040 && code <= 0x30ff)
      || (code >= 0xac00 && code <= 0xd7af)
      || (code >= 0xf900 && code <= 0xfaff) ? 4 : 1
  }
  return units
}

type RateSample = { units: number; elapsed_ms: number }
export function rateFromSample(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null
  const { units, elapsed_ms } = value as RateSample
  if (!Number.isFinite(units) || units <= 0
    || !Number.isFinite(elapsed_ms) || elapsed_ms <= 0) return null
  return Math.round((units / 4) / (elapsed_ms / 1000))
}

/** Original event timestamps are used for both live output and history replay. */
export function collectOutputRate(events: unknown[]) {
  let startedAt: number | null = null
  let lastAt: number | null = null
  let units = 0
  let sample: RateSample | null = null
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue
    const event = raw as Record<string, any>
    const data = event.data ?? {}
    if (isToolEvent(event) || BOUNDARY_TYPES.has(event.type)
      || (event.type === 'CUSTOM' && event.name === 'workstep.interaction_request')) {
      startedAt = null
      lastAt = null
      units = 0
      continue
    }
    if (!OUTPUT_TYPES.has(event.type) || (event.role ?? data.role) === 'user') continue
    const text = event.delta ?? data.delta ?? data.text ?? data.content?.text
    const at = toMilliseconds((event.timestamp ?? event.created_at) as DateTimeValue)
    if (typeof text !== 'string' || !text || at === null) continue
    if (lastAt !== null && at < lastAt) continue
    lastAt = at
    // The first batch has no observed generation interval; use it as the anchor.
    if (startedAt === null) {
      startedAt = at
      continue
    }
    units += tokenUnits(text)
    if (at > startedAt) sample = { units, elapsed_ms: at - startedAt }
  }
  return { sample }
}

export function outputRateFromEvents(events: unknown[]): number | null {
  return rateFromSample(collectOutputRate(events).sample)
}
