/**
 * applyWorkflowPatch — partial application of incremental flow proposals.
 *
 * The AI flow assistant can return a patch describing only the steps it
 * touched (``upsertNodes`` / ``removeNodeIds`` / optional ``connections``).
 * The backend already merged that patch into a complete canvas, but the user
 * may want to keep only *some* of the changed steps. Given the current canvas
 * and a proposal's patch + step list, this produces a merged canvas that
 * applies just the selected steps.
 */

export interface StepChange {
  id: number
  key: string
  title: string
  change: 'added' | 'updated' | 'removed'
}

export interface WorkflowPatch {
  upsertNodes?: Record<string, unknown>[]
  removeNodeIds?: number[]
  connections?: Record<string, unknown>[]
}

function coerceId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10)
    return parsed > 0 ? parsed : null
  }
  return null
}

/**
 * Merge ``patch`` into ``baseSteps`` applying only the steps named in
 * ``selectedIds``. A ``null`` selection applies every changed step.
 */
export function applyWorkflowPatch(
  baseSteps: any,
  patch: WorkflowPatch,
  selectedIds: Set<number> | null,
): any {
  const base = baseSteps && typeof baseSteps === 'object' ? baseSteps : {}
  const baseNodes = Array.isArray(base.nodes) ? base.nodes : []
  const nodesById = new Map<number, Record<string, unknown>>()
  const order: number[] = []
  for (const node of baseNodes) {
    const id = coerceId(node?.id)
    if (id === null) continue
    if (!nodesById.has(id)) order.push(id)
    nodesById.set(id, node)
  }
  const shouldApply = (id: number) => selectedIds === null || selectedIds.has(id)

  let nextId = order.reduce((max, id) => Math.max(max, id), 0) + 1
  for (const rawNode of patch.upsertNodes ?? []) {
    const node = { ...rawNode }
    let id = coerceId(node.id)
    if (id === null) {
      // The backend fills in ids for new steps; this only covers a raw patch
      // that reached the editor unresolved.
      if (selectedIds !== null) continue
      while (nodesById.has(nextId)) nextId += 1
      id = nextId
      nextId += 1
    }
    if (!shouldApply(id)) continue
    node.id = id
    if (!nodesById.has(id)) order.push(id)
    nodesById.set(id, node)
  }

  for (const rawId of patch.removeNodeIds ?? []) {
    const id = coerceId(rawId)
    if (id === null || !shouldApply(id)) continue
    nodesById.delete(id)
    const index = order.indexOf(id)
    if (index >= 0) order.splice(index, 1)
  }

  const nodeIds = new Set(order)
  const connections: Record<string, unknown>[] = Array.isArray(patch.connections)
    ? (patch.connections as Record<string, unknown>[])
    : Array.isArray(base.connections)
      ? (base.connections as Record<string, unknown>[])
      : []
  const keptConnections = connections.filter((conn) => {
    const from = coerceId(conn?.from)
    const to = coerceId(conn?.to)
    return from !== null && to !== null && nodeIds.has(from) && nodeIds.has(to)
  })

  return {
    ...base,
    nodes: order.map((id) => nodesById.get(id)),
    connections: keptConnections,
  }
}

/** Default selection: every step the proposal changed. */
export function changedStepIds(changes: StepChange[] | undefined): Set<number> {
  return new Set((changes ?? []).map((entry) => entry.id))
}
