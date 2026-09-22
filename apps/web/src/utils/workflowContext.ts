export type WorkflowContextMode = 'initial' | 'canvas_updated' | 'none'

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    )
  }
  return value
}

export function workflowCanvasSnapshot(steps: unknown): string {
  return JSON.stringify(stableValue(steps ?? {}))
}

export function selectWorkflowTurnContext(
  workflowName: string,
  steps: unknown,
  previousSnapshot: string | null,
): {
  mode: WorkflowContextMode
  workflowName?: string
  steps?: unknown
  snapshot: string
} {
  const snapshot = workflowCanvasSnapshot(steps)
  if (previousSnapshot === null) {
    return { mode: 'initial', workflowName, steps, snapshot }
  }
  if (snapshot !== previousSnapshot) {
    return { mode: 'canvas_updated', steps, snapshot }
  }
  return { mode: 'none', snapshot }
}
