import { getMessageHistoryPageSize, loadMessageHistoryPageSize } from '../stores/userSettingsStore'
import { useCallback, useEffect, useRef } from 'react'
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
  const pageRef = useRef({ key: '', offset: 0, hasOlder: false, loading: false })
  const callback = useRef(onSession)
  callback.current = onSession
  useEffect(() => {
    if (!workflowId) return
    const page = { key: workflowSessionId(projectId, workflowId), offset: 0, hasOlder: false, loading: true }
    pageRef.current = page
    let sessionId = page.key
    callback.current(sessionId)
    useWorkflowGenStore.getState().newSession(sessionId)
    let active = true
    let inFlight = false
    let refreshPending = false
    const load = () => {
      if (inFlight) { refreshPending = true; return }
      inFlight = true
      page.loading = true
      const unchanged = useWorkflowGenStore.getState().sessions[sessionId]?.messages ?? []
      let pageSize = getMessageHistoryPageSize()
      void loadMessageHistoryPageSize().then(limit => {
        pageSize = limit
        return active ? workflowGenApi.history(projectId, workflowId, limit, 0) : null
      })
        .then((history) => {
          if (!active || !history) return
          if (!page.offset) {
            page.offset = history.messages.length
            page.hasOlder = history.messages.length === pageSize
          }
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
          page.loading = false
          if (active && refreshPending) { refreshPending = false; load() }
        })
    }
    window.addEventListener('workstep:reconnected', load)
    load()
    return () => {
      active = false
      if (pageRef.current === page) pageRef.current = { key: '', offset: 0, hasOlder: false, loading: false }
      window.removeEventListener('workstep:reconnected', load)
    }
  }, [projectId, workflowId])

  const loadOlderHistory = useCallback(async (beforePrepend?: () => void) => {
    const page = pageRef.current
    if (!workflowId || page.key !== workflowSessionId(projectId, workflowId) || page.loading || !page.hasOlder) return
    page.loading = true
    try {
      const limit = getMessageHistoryPageSize()
      const history = await workflowGenApi.history(projectId, workflowId, limit, page.offset)
      if (pageRef.current !== page) return
      page.offset += history.messages.length
      page.hasOlder = history.messages.length === limit
      if (history.messages.length) {
        beforePrepend?.()
        useWorkflowGenStore.getState().hydrateSession(history.session_id, history.messages.map(message => ({
          ...message, events: (message.events || []).map(event => ({ ...event, type: event.type || '', data: event.data || {} })),
        })), false)
      }
    } catch {
      // Retain the cursor so scrolling can retry.
    } finally { page.loading = false }
  }, [projectId, workflowId])
  const resetPagination = useCallback(() => {
    pageRef.current.offset = 0
    pageRef.current.hasOlder = false
  }, [])
  return { loadOlderHistory, resetPagination }
}
