export interface TaskDetailLink { projectId: string; taskId: string }

/** Only the explicit local navigation protocol is eligible for a task button. */
export function parseTaskDetailLink(href: string | undefined): TaskDetailLink | null {
  if (!href?.startsWith('workstep-task://')) return null
  try {
    const url = new URL(href)
    const projectId = url.searchParams.get('project_id')
    const taskId = url.searchParams.get('task_id')
    if (url.hostname !== 'open' || url.username || url.password || url.port || url.hash
      || (url.pathname && url.pathname !== '/') || !projectId?.trim() || !taskId?.trim()
      || projectId.length > 256 || taskId.length > 128) return null
    return { projectId, taskId }
  } catch { return null }
}
