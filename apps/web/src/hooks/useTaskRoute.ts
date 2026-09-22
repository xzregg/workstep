import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'

export function taskListPath(project: string, workflowId: string): string {
  const params = new URLSearchParams({ project, workflow: workflowId })
  return `/tasks?${params.toString()}`
}

export function useTaskRoute() {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  return {
    taskId: params.get('task'),
    openTask(taskId: string, project?: string, workflowId?: string) {
      const next = new URLSearchParams(params)
      next.set('task', taskId)
      if (project) next.set('project', project)
      if (workflowId) next.set('workflow', workflowId)
      setParams(next, { state: { ...location.state, taskListEntry: true } })
    },
    closeTask() {
      if (location.state?.taskListEntry) navigate(-1)
      else {
        const next = new URLSearchParams(params)
        next.delete('task')
        setParams(next, { replace: true })
      }
    },
  }
}
