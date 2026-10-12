import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

export function taskListPath(project: string, workflowId: string): string {
  const params = new URLSearchParams({ project, workflow: workflowId })
  return `/tasks?${params.toString()}`
}

export function useTaskRoute() {
  const [params, setParams] = useSearchParams()
  const routeTaskId = params.get('task')
  const [dismissedTaskId, setDismissedTaskId] = useState<string | null>(null)
  useEffect(() => { setDismissedTaskId(null) }, [routeTaskId])
  return {
    taskId: routeTaskId === dismissedTaskId ? null : routeTaskId,
    openTask(taskId: string, project?: string, workflowId?: string) {
      setDismissedTaskId(null)
      const next = new URLSearchParams(params)
      next.set('task', taskId)
      if (project) next.set('project', project)
      if (workflowId) next.set('workflow', workflowId)
      setParams(next)
    },
    closeTask() {
      // Dismiss urgently; router transitions can wait behind streaming renders.
      setDismissedTaskId(routeTaskId)
      // A previous entry may still be a task detail (task switching or a mobile
      // overlay). Closing must explicitly clear the selection, not step back.
      const next = new URLSearchParams(params)
      next.delete('task')
      setParams(next, { replace: true })
    },
  }
}
