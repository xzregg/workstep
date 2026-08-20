export const FALLBACK_CONTEXT_WINDOW = 200_000

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
    const total = reportedSize > 0 ? reportedSize : FALLBACK_CONTEXT_WINDOW
    return {
      used,
      total,
      percent: Math.min(100, (used / total) * 100),
    }
  }
  return null
}
