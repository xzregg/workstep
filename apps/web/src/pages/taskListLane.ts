export interface TaskLane {
  key: string
  label: string
  color: string
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
