import { useEffect, useState } from 'react'
import type { Task } from '../api/client'
import { useTaskStore } from '../stores/taskStore'

/** Keeps a task detail available when a filtered board list replaces its row. */
export function useTaskRecord(taskId: string, projectId: string): Task | undefined {
  const listed = useTaskStore((state) => state.tasks.find((task) => task.id === taskId))
  const refreshTask = useTaskStore((state) => state.refreshTask)
  const [loaded, setLoaded] = useState<{ taskId: string; projectId: string; task: Task } | null>(null)

  useEffect(() => {
    if (!taskId || !projectId) return
    let active = true
    void refreshTask(taskId, projectId)
      .then((task) => {
        if (active) setLoaded({ taskId, projectId, task })
      })
      .catch(() => undefined)
    return () => { active = false }
  }, [projectId, refreshTask, taskId])

  return listed ?? (loaded?.taskId === taskId && loaded.projectId === projectId
    ? loaded.task : undefined)
}
