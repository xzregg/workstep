import { useEffect, useRef } from 'react'
import { useRecentVisitsStore, type RecentVisitTarget } from '../stores/recentVisitsStore'
import { appearanceStorageKey } from '../utils/appearanceStorage'

/** Metadata refreshes keep the visit time; reopening a page promotes it. */
export function useRecordRecentVisit(target: RecentVisitTarget | null) {
  const identity = target ? JSON.stringify([appearanceStorageKey('recent'), target.kind, target.projectId, target.id]) : null
  const previous = useRef<string | null>(null)
  const kind = target?.kind, id = target?.id, projectId = target?.projectId, title = target?.title, workflowId = target?.workflowId
  useEffect(() => {
    if (!kind || !id || !projectId || title === undefined) { previous.current = null; return }
    const store = useRecentVisitsStore.getState()
    const value = { kind, id, projectId, title, workflowId }
    if (previous.current !== identity) store.visit(value)
    else store.update(value)
    previous.current = identity
  }, [identity, kind, id, projectId, title, workflowId])
}
