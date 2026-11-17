/** Bound untrusted model output before A2UI/Zod can accumulate validation issues.
 * Limits apply to the entire batch, including data-model values, not just the
 * visible components. This is admission control, not a replacement for schemas.
 */
export const A2UI_INPUT_LIMITS = Object.freeze({
  messages: 256,
  collection: 512,
  depth: 32,
  nodes: 8192,
  text: 1_048_576,
})

export function isWithinA2uiInputBudget(input: unknown): boolean {
  const pending = [{ value: input, depth: 0 }]
  let nodes = 0
  let text = 0
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (++nodes > A2UI_INPUT_LIMITS.nodes || depth > A2UI_INPUT_LIMITS.depth) return false
    if (typeof value === 'string') {
      text += value.length
      if (text > A2UI_INPUT_LIMITS.text) return false
    } else if (Array.isArray(value)) {
      if (value.length > A2UI_INPUT_LIMITS.collection) return false
      for (const item of value) pending.push({ value: item, depth: depth + 1 })
    } else if (value !== null && typeof value === 'object') {
      let keys = 0
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue
        text += key.length
        if (++keys > A2UI_INPUT_LIMITS.collection || text > A2UI_INPUT_LIMITS.text) return false
        pending.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 })
      }
    }
  }
  return true
}
