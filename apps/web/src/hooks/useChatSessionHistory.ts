import { useCallback, useEffect, useRef, useState } from 'react'
import { chatSessionApi, type ChatSessionDetail } from '../api/client'
import { useI18n } from '../i18n'
import { useChatSessionStore } from '../stores/chatSessionStore'

const PAGE_SIZE = 300

function normalizeMessages(messages: ChatSessionDetail['messages']) {
  return messages.map((message) => ({
    ...message,
    events: (message.events || []).map((event) => ({
      ...event, type: event.type || '', data: event.data || {},
    })),
  }))
}

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
  const [historyError, setHistoryError] = useState('')
  const [historyLoading, setHistoryLoading] = useState(false)
  const retryRef = useRef<() => void>(() => {})
  const retryHistory = useCallback(() => retryRef.current(), [])
  const pageRef = useRef({ key: '', offset: 0, hasOlder: false, loading: false })
  const { t } = useI18n()
  const callbacks = useRef({ onLoaded, onMissing })
  callbacks.current = { onLoaded, onMissing }

  useEffect(() => {
    setHistoryError('')
    setHistoryLoading(false)
    if (!sessionId || !projectId) return
    let active = true
    const page = { key: `${projectId}/${sessionId}`, offset: 0, hasOlder: false, loading: true }
    pageRef.current = page
    const store = useChatSessionStore.getState()
    store.newSession(sessionId)
    let inFlight = false
    let refreshPending = false
    const load = (refresh = false) => {
      if (inFlight) { refreshPending = true; return }
      inFlight = true
      setHistoryError('')
      setHistoryLoading(true)
      page.loading = true
      const unchangedMessages = useChatSessionStore.getState().sessions[sessionId]?.messages || []
      void chatSessionApi.get(sessionId, projectId, PAGE_SIZE, 0)
        .then((detail) => {
          if (!active) return
          page.offset = detail.messages?.length || 0
          page.hasOlder = page.offset === PAGE_SIZE
          page.loading = false
          if (!refresh) callbacks.current.onLoaded(detail)
          store.newSession(detail.id)
          store.hydrateSession(
            detail.id,
            normalizeMessages(detail.messages || []),
            detail.running,
            unchangedMessages,
          )
        })
        .catch((reason) => {
          page.loading = false
          if (!active) return
          if (reason?.status === 404 && !refresh) callbacks.current.onMissing()
          else setHistoryError(`${reason?.status ? `HTTP ${reason.status}: ` : ''}${reason instanceof Error ? reason.message : t('chatSession.loadFailed')}`)
        })
        .finally(() => {
          inFlight = false
          if (active) setHistoryLoading(false)
          if (active && refreshPending) { refreshPending = false; load(true) }
        })
    }
    retryRef.current = () => load()
    const recovered = () => load(true)
    window.addEventListener('workstep:reconnected', recovered)
    load()
    return () => {
      active = false
      retryRef.current = () => {}
      window.removeEventListener('workstep:reconnected', recovered)
      pageRef.current = { key: '', offset: 0, hasOlder: false, loading: false }
    }
  }, [sessionId, projectId])

  const loadOlderHistory = useCallback(async (beforePrepend?: () => void) => {
    const currentSessionId = messageSessionId || sessionId
    const page = pageRef.current
    if (!currentSessionId || !projectId || page.key !== `${projectId}/${currentSessionId}`
      || page.loading || !page.hasOlder) return
    page.loading = true
    try {
      const detail = await chatSessionApi.get(currentSessionId, projectId, PAGE_SIZE, page.offset)
      if (pageRef.current !== page) return
      const messages = detail.messages || []
      page.offset += messages.length
      page.hasOlder = messages.length === PAGE_SIZE
      if (messages.length) {
        beforePrepend?.()
        useChatSessionStore.getState().hydrateSession(currentSessionId, normalizeMessages(messages), false)
      }
    } catch {
      // Keep the offset so another upward scroll can retry this page.
    } finally {
      page.loading = false
    }
  }, [sessionId, messageSessionId, projectId])

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

  return { loadMessageEvents, loadOlderHistory, historyError, historyLoading, retryHistory }
}
