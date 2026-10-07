import { useEffect, useRef } from 'react'
import { workflowGenApi } from '../api/client'
import { useWorkflowGenStore } from '../stores/workflowGenStore'

/** Stable conversation id for a workflow edit session (mirrors backend key). */
export function workflowSessionId(projectId: string, workflowId: string): string {
  return `wf:${projectId}:${workflowId}`
}

/** Recover the selected workflow through the same history/live merge as other assistants. */
export function useWorkflowConversationHistory(
  projectId: string,
  workflowId: string | undefined,
  onSession: (sessionId: string) => void,
) {
  const callback = useRef(onSession)
  callback.current = onSession
  useEffect(() => {
    if (!workflowId) return
    let sessionId = workflowSessionId(projectId, workflowId)
    callback.current(sessionId)
    useWorkflowGenStore.getState().newSession(sessionId)
    let active = true
    let inFlight = false
    let refreshPending = false
    const load = () => {
      if (inFlight) { refreshPending = true; return }
      inFlight = true
      const unchanged = useWorkflowGenStore.getState().sessions[sessionId]?.messages ?? []
      void workflowGenApi.history(projectId, workflowId)
        .then((history) => {
          if (!active) return
          const store = useWorkflowGenStore.getState()
          store.newSession(history.session_id)
          store.hydrateSession(history.session_id, (history.messages || []).map((message) => ({
            ...message,
            events: (message.events || []).map((event) => ({
              ...event, type: event.type || '', data: event.data || {},
            })),
          })), false, unchanged)
          sessionId = history.session_id
          callback.current(sessionId)
        })
        .catch(() => { /* Keep cached messages; a reconnect or reopening can retry. */ })
        .finally(() => {
          inFlight = false
          if (active && refreshPending) { refreshPending = false; load() }
        })
    }
    window.addEventListener('workstep:reconnected', load)
    load()
    return () => {
      active = false
      window.removeEventListener('workstep:reconnected', load)
    }
  }, [projectId, workflowId])
}
