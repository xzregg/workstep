import { useCallback, useEffect, useState } from 'react'
import type { Task } from '../api/client'
import { ApiError } from '../api/transport'
import { useTaskStore } from '../stores/taskStore'

/** Keeps a task detail available when a filtered board list replaces its row. */
export function useTaskRecord(taskId: string, projectId: string) {
  const listed = useTaskStore((state) => state.tasks.find((task) => task.id === taskId))
  const refreshTask = useTaskStore((state) => state.refreshTask)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  const [result, setResult] = useState<{
    taskId: string; projectId: string; attempt: number; task?: Task; error?: Error
  } | null>(null)

  useEffect(() => {
    if (!taskId || !projectId) return
    let active = true
    void refreshTask(taskId, projectId)
      .then((task) => {
        if (active) setResult({ taskId, projectId, attempt, task })
      })
      .catch((error: unknown) => {
        if (active) setResult({ taskId, projectId, attempt,
          error: error instanceof Error ? error : new Error(String(error)) })
      })
    return () => { active = false }
  }, [projectId, refreshTask, taskId, attempt])

  const current = result?.taskId === taskId && result.projectId === projectId
    && result.attempt === attempt ? result : null
  const task = listed ?? current?.task
  const status = task ? 'ready' : !current ? 'loading'
    : current.error instanceof ApiError && current.error.status === 404 ? 'not-found' : 'error'
  return { task, status, error: current?.error?.message, retry }
}
