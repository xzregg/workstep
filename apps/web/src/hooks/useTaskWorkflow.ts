import { useEffect, useState } from 'react'
import type { TaskWorkflowConfiguration } from '../api/taskWorkflow'

/** One request owner; ignore results from closed tasks or older source revisions. */
export function useTaskWorkflow(load: () => Promise<TaskWorkflowConfiguration>, identity: string, signal: string, busy = false) {
  const [result, setResult] = useState<{ identity: string; value?: TaskWorkflowConfiguration; error?: string }>()
  useEffect(() => {
    let active = true
    void Promise.resolve().then(load).then((value) => {
      if (active) setResult({ identity, value })
    }).catch((reason) => {
      if (active) setResult({ identity, error: String(reason) })
    })
    return () => { active = false }
  }, [load, identity, signal, busy])
  const current = result?.identity === identity ? result : undefined
  const configuration = busy && current?.value ? { ...current.value, editable: false } : current?.value
  return { configuration, error: current?.error,
    update: (value: TaskWorkflowConfiguration) => setResult({ identity, value }) }
}
