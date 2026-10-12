import { useEffect, useRef } from 'react'
import { useChatListStore } from '../stores/chatSessionStore'

/** Refresh previews after the same conversation finishes, never on navigation. */
export function useChatListTurnRefresh(projectId: string | undefined, sessionId: string | null, running: boolean) {
  const previous = useRef({ projectId, sessionId, running })
  useEffect(() => {
    const before = previous.current
    previous.current = { projectId, sessionId, running }
    if (projectId && sessionId && before.projectId === projectId && before.sessionId === sessionId
      && before.running && !running) {
      useChatListStore.getState().refreshSessions(projectId)
    }
  }, [projectId, sessionId, running])
}
