import { useSearchParams } from 'react-router-dom'

export function taskListPath(project: string, workflowId: string): string {
  const params = new URLSearchParams({ project, workflow: workflowId })
  return `/tasks?${params.toString()}`
}

export function useTaskRoute() {
  const [params, setParams] = useSearchParams()
  return {
    taskId: params.get('task'),
    openTask(taskId: string, project?: string, workflowId?: string) {
      const next = new URLSearchParams(params)
      next.set('task', taskId)
      if (project) next.set('project', project)
      if (workflowId) next.set('workflow', workflowId)
      setParams(next)
    },
    closeTask() {
      // A previous entry may still be a task detail (task switching or a mobile
      // overlay). Closing must explicitly clear the selection, not step back.
      const next = new URLSearchParams(params)
      next.delete('task')
      setParams(next, { replace: true })
    },
  }
}
