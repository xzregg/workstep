/** Keep task lists and detail headers consistent about review waits. */
export function taskDisplayStatus(
  status: string | null | undefined,
  steps: ReadonlyArray<{ status?: string | null; waiting_reason?: string | null; in_workflow?: boolean }>,
  completed: boolean,
  reason?: string | null,
) {
  const current = steps.filter((step) => step.in_workflow !== false)
  const waiting = reason === 'manual_review' ? 'awaiting_review' : ['tool_approval', 'user_input'].includes(reason || '') ? reason! : 'waiting'
  if (status === 'waiting') return { stepStatus: waiting, displayStatus: waiting }
  if (status === 'failed' || status === 'stopped' || status === 'queued') {
    return { stepStatus: undefined, displayStatus: status }
  }
  if (status === 'completed' || (completed && status !== 'running')) return { stepStatus: undefined, displayStatus: 'done' }
  const active = current.find((step) => ['running', 'reviewing', 'retrying', 'rework'].includes(step.status || '') && !step.waiting_reason)
  if (active || (status === 'running' && reason)) {
    const state = reason === 'auto_review' ? 'reviewing' : reason === 'rework' ? 'retrying' : active?.status || 'running'
    return { stepStatus: state === 'running' ? undefined : state, displayStatus: state }
  }
  const stepStatus = current.some((step) => step.status === 'awaiting_review') ? 'awaiting_review'
    : current.find((step) => step.waiting_reason)?.waiting_reason || undefined
  return { stepStatus, displayStatus: stepStatus || (status === 'paused' ? 'failed' : status) || 'ready' }
}

export function hasActiveTaskExecution(task: {
  status?: string
  steps?: ReadonlyArray<{ status?: string; in_workflow?: boolean }>
} | null | undefined): boolean {
  return task?.status === 'running' || (task?.status === 'waiting' && Boolean(task.steps?.some(
    (step) => step.in_workflow !== false && (step.status === 'running' || step.status === 'reviewing'),
  )))
}
