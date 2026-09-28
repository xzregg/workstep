import { useCallback, useEffect, useRef } from 'react'
import { chatSessionApi, type ChatSessionDetail } from '../api/client'
import { useI18n } from '../i18n'
import { useChatSessionStore } from '../stores/chatSessionStore'

interface Options {
  /** Session selected by the URL; only this identity triggers history hydration. */
  sessionId: string | null
  /** Current store session can change when the send endpoint migrates its id. */
  messageSessionId?: string | null
  projectId?: string
  onLoaded: (detail: ChatSessionDetail) => void
  onMissing: () => void
}

/** Loads a selected session and its paged event details into the shared store. */
export function useChatSessionHistory({ sessionId, messageSessionId, projectId, onLoaded, onMissing }: Options) {
  const { t } = useI18n()
  const callbacks = useRef({ onLoaded, onMissing })
  callbacks.current = { onLoaded, onMissing }

  useEffect(() => {
    if (!sessionId || !projectId) return
    let active = true
    const store = useChatSessionStore.getState()
    store.newSession(sessionId)
    chatSessionApi.get(sessionId, projectId)
      .then((detail) => {
        if (!active) return
        callbacks.current.onLoaded(detail)
        store.newSession(detail.id)
        store.hydrateSession(
          detail.id,
          (detail.messages || []).map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            status: message.status,
            engine: message.engine,
            model: message.model,
            created_at: message.created_at,
            ended_at: message.ended_at,
            prompt: message.prompt,
            author_id: message.author_id,
            author_username: message.author_username,
            author_name: message.author_name,
            author_type: message.author_type,
            initiated_by_user_id: message.initiated_by_user_id,
            initiated_by_username: message.initiated_by_username,
            author_device_id: message.author_device_id,
            author_device_name: message.author_device_name,
            event_summary: message.event_summary,
            event_detail: message.event_detail,
            events: (message.events || []).map((event) => ({
              ...event,
              type: event.type || '',
              data: event.data || {},
            })),
          })),
          detail.running,
        )
      })
      .catch(() => {
        if (active) callbacks.current.onMissing()
      })
    return () => { active = false }
  }, [sessionId, projectId])

  const loadMessageEvents = useCallback(async (messageId: string) => {
    const currentSessionId = messageSessionId || sessionId
    if (!currentSessionId || !projectId) return
    const store = useChatSessionStore.getState()
    const message = store.sessions[currentSessionId]?.messages.find((item) => item.id === messageId)
    if (!message?.event_detail?.available || message.event_detail.loaded || message.event_detail.loading) return
    store.setMessageEventLoading(currentSessionId, messageId, true)
    try {
      let cursor = 0
      let complete = false
      const events = [] as NonNullable<typeof message.events>
      while (!complete) {
        const page = await chatSessionApi.messageEvents(currentSessionId, messageId, projectId, cursor)
        events.push(...page.events.map((event) => ({
          ...event,
          type: event.type || '',
          data: event.data || {},
        })))
        complete = page.complete || page.next_cursor === null
        if (!complete) {
          const nextCursor = page.next_cursor
          if (nextCursor === null || nextCursor === cursor) {
            throw new Error('Event detail cursor did not advance')
          }
          cursor = nextCursor
        }
      }
      store.setMessageEventDetails(currentSessionId, messageId, events, {
        complete: true,
        next_cursor: null,
      })
    } catch (reason) {
      store.setMessageEventLoading(
        currentSessionId, messageId, false,
        reason instanceof Error ? reason.message : t('chatSession.loadFailed'),
      )
    }
  }, [sessionId, messageSessionId, projectId, t])

  return { loadMessageEvents }
}
