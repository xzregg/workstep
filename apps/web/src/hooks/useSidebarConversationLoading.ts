import { useEffect, useRef } from 'react'
import { useChatListStore } from '../stores/chatSessionStore'

/** One load per visible expansion; failed requests wait for a user action. */
export function useSidebarConversationLoading(visible: boolean, projectIds: string[]) {
  const attempted = useRef(new Set<string>())
  const projectKey = JSON.stringify(projectIds)
  useEffect(() => {
    if (!visible) {
      attempted.current.clear()
      return
    }
    const ids = JSON.parse(projectKey) as string[]
    const current = new Set(ids)
    for (const id of attempted.current) {
      if (!current.has(id)) attempted.current.delete(id)
    }
    for (const id of ids) {
      if (attempted.current.has(id)) continue
      attempted.current.add(id)
      void useChatListStore.getState().fetchSessions(id, true)
    }
  }, [visible, projectKey])
}
