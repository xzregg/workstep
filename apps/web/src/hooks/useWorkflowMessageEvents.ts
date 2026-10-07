import { useCallback } from 'react'
import { workflowGenApi } from '../api/conversations'
import { useI18n } from '../i18n'
import { useWorkflowGenStore } from '../stores/workflowGenStore'

/** Fetch the full persisted process only when its trace is expanded. */
export function useWorkflowMessageEvents(projectId: string, workflowId: string | undefined, sessionId: string | null) {
  const { t } = useI18n()
  return useCallback(async (messageId: string) => {
    if (!workflowId || !sessionId) return
    const store = useWorkflowGenStore.getState()
    const message = store.sessions[sessionId]?.messages.find(item => item.id === messageId)
    if (!message?.event_detail?.available || message.event_detail.loaded || message.event_detail.loading) return
    store.setMessageEventLoading(sessionId, messageId, true)
    try {
      let cursor = 0
      const events = [] as NonNullable<typeof message.events>
      while (true) {
        const page = await workflowGenApi.messageEvents(projectId, workflowId, messageId, cursor)
        events.push(...page.events.map(event => ({ ...event, type: event.type || '', data: event.data || {} })))
        if (page.complete || page.next_cursor === null) break
        if (page.next_cursor <= cursor) throw new Error('Event detail cursor did not advance')
        cursor = page.next_cursor
      }
      store.setMessageEventDetails(sessionId, messageId, events, { complete: true, next_cursor: null })
    } catch (reason) {
      store.setMessageEventLoading(sessionId, messageId, false,
        reason instanceof Error ? reason.message : t('chatSession.loadFailed'))
    }
  }, [projectId, workflowId, sessionId, t])
}
