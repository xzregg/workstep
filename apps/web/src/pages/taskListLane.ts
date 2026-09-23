export interface TaskLane {
  key: string
  label: string
  color: string
}

interface WorkflowForLanes {
  nodes?: Array<{ id: string | number; key?: string; type?: string }>
  connections?: Array<{ from: string | number; to: string | number; kind?: string }>
  steps?: Array<{ key?: string; id?: string; dependsOn?: string[] }>
}

export function orderTaskLanes(lanes: TaskLane[], workflow: WorkflowForLanes): TaskLane[] {
  const dependencies = new Map(lanes.map((lane) => [lane.key, new Set<string>()]))
  if (workflow.nodes?.length) {
    const keyById = new Map(workflow.nodes.map((node) => [
      String(node.id), node.key || node.type || String(node.id),
    ]))
    for (const connection of workflow.connections || []) {
      if (connection.kind === 'dashed') continue
      const from = keyById.get(String(connection.from))
      const to = keyById.get(String(connection.to))
      if (from && to && dependencies.has(from)) dependencies.get(to)?.add(from)
    }
  } else {
    for (const step of workflow.steps || []) {
      const key = step.key || step.id
      for (const dependency of step.dependsOn || []) {
        if (key && dependencies.has(dependency)) dependencies.get(key)?.add(dependency)
      }
    }
  }

  const ordered: TaskLane[] = []
  const remaining = [...lanes]
  const placed = new Set<string>()
  while (remaining.length) {
    const index = remaining.findIndex((lane) =>
      [...(dependencies.get(lane.key) || [])].every((dependency) => placed.has(dependency)))
    if (index < 0) return [...ordered, ...remaining]
    const [lane] = remaining.splice(index, 1)
    ordered.push(lane)
    placed.add(lane.key)
  }
  return ordered
}

interface TaskWithSteps {
  steps?: Array<{
    step_key: string
    status: string
    started_at?: string | null
    ended_at?: string | null
  }>
}

const ACTIVE_STATUS_PRIORITY = [
  'reviewing',
  'awaiting_review',
  'retrying',
  'rework_waiting',
  'rework',
  'running',
  'rejected',
  'failed',
  'cancelled',
  'pending',
] as const

export function deriveTaskLane(task: TaskWithSteps, lanes: TaskLane[]): string {
  const stepByKey = new Map(
    (task.steps || []).map((step) => [step.step_key, step]),
  )
  const findLane = (status: string) =>
    lanes.find((lane) => stepByKey.get(lane.key)?.status === status)?.key

  for (const status of ACTIVE_STATUS_PRIORITY) {
    const lane = findLane(status)
    if (lane) return lane
  }

  const latestCompletedLane = lanes.reduce<{
    key: string
    timestamp: number
  } | null>((latest, lane) => {
    const step = stepByKey.get(lane.key)
    if (step?.status !== 'passed' && step?.status !== 'skipped') return latest
    const timestamp = Date.parse(step.ended_at || step.started_at || '')
    if (!Number.isFinite(timestamp) || (latest && timestamp <= latest.timestamp)) {
      return latest
    }
    return { key: lane.key, timestamp }
  }, null)
  if (latestCompletedLane) return latestCompletedLane.key

  // Older task snapshots may not contain execution timestamps.
  return [...lanes].reverse().find((lane) => {
    const status = stepByKey.get(lane.key)?.status
    return status === 'passed' || status === 'skipped'
  })?.key || lanes[0]?.key || 'do'
}
