import type { FileChangesQuery } from '../utils/messageFileChanges'
import { useCallback, useEffect, useRef, useState } from 'react'
import { chatSessionApi, type ChatSessionDetail } from '../api/client'
import { useI18n } from '../i18n'
import { getMessageHistoryPageSize, loadMessageHistoryPageSize } from '../stores/userSettingsStore'
import { useChatSessionStore } from '../stores/chatSessionStore'
import type { AssistantChatMessage } from '../stores/assistantStore'
import { useChatExecutionConfigStore } from '../stores/chatExecutionConfigStore'

function normalizeMessages(messages: ChatSessionDetail['messages']) {
  return messages.map((message) => ({
    ...message,
    events: (message.events || []).map((event) => ({
      ...event, type: event.type || '', data: event.data || {},
    })),
  }))
}

export interface InitialSessionHistory {
  projectId: string
  detail: ChatSessionDetail
  limit: number
  unchangedMessages: AssistantChatMessage[]
}

/** Load the first page and retain the live-message snapshot used when merging it. */
export async function loadInitialSessionHistory(sessionId: string, projectId: string): Promise<InitialSessionHistory> {
  const limit = await loadMessageHistoryPageSize()
  const unchangedMessages = useChatSessionStore.getState().sessions[sessionId]?.messages ?? []
  const detail = await chatSessionApi.get(sessionId, projectId, limit, 0)
  return { projectId, detail, limit, unchangedMessages }
}

interface Options {
  /** Session selected by the URL; only this identity triggers history hydration. */
  sessionId: string | null
  /** Current store session can change when the send endpoint migrates its id. */
  messageSessionId?: string | null
  projectId?: string
  initialHistory?: InitialSessionHistory
  onLoaded: (detail: ChatSessionDetail) => void
  onMissing: () => void
}

/** Loads a selected session and its paged event details into the shared store. */
export function useChatSessionHistory({ sessionId, messageSessionId, projectId, initialHistory, onLoaded, onMissing }: Options) {
  const [historyError, setHistoryError] = useState('')
  const [historyLoading, setHistoryLoading] = useState(false)
  const [loadedScope, setLoadedScope] = useState('')
  const historyReady = Boolean(projectId && sessionId && loadedScope === `${projectId}/${sessionId}`)
  const retryRef = useRef<() => void>(() => {})
  const retryHistory = useCallback(() => retryRef.current(), [])
  const pageRef = useRef({ key: '', offset: 0, hasOlder: false, loading: false, limit: getMessageHistoryPageSize() })
  const { t } = useI18n()
  const callbacks = useRef({ onLoaded, onMissing })
  const preparedHistory = useRef(initialHistory)
  callbacks.current = { onLoaded, onMissing }

  useEffect(() => {
    setHistoryError('')
    setHistoryLoading(false)
    if (!sessionId || !projectId) return
    let active = true
    // Settings changes affect the next request without reloading the conversation.
    const page = { limit: getMessageHistoryPageSize(), key: `${projectId}/${sessionId}`, offset: 0, hasOlder: false, loading: true }
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
      const prepared = !refresh && preparedHistory.current?.projectId === projectId &&
        preparedHistory.current.detail.id === sessionId ? preparedHistory.current : undefined
      const unchangedMessages = prepared?.unchangedMessages ?? useChatSessionStore.getState().sessions[sessionId]?.messages ?? []
      const firstPage = prepared ? Promise.resolve(prepared.detail) : loadMessageHistoryPageSize().then(limit => {
        page.limit = limit
        if (!active) return null
        return chatSessionApi.get(sessionId, projectId, page.limit, 0)
      })
      void firstPage
        .then((detail) => {
          if (!active || !detail) return
          if (prepared) {
            page.limit = prepared.limit
            preparedHistory.current = undefined
          }
          useChatExecutionConfigStore.getState().receive(projectId, detail)
          page.offset = detail.messages?.length || 0
          page.hasOlder = page.offset === page.limit
          page.loading = false
          if (!refresh) callbacks.current.onLoaded(detail)
          store.newSession(detail.id)
          store.hydrateSession(
            detail.id,
            normalizeMessages(detail.messages || []),
            detail.running,
            unchangedMessages,
          )
          setLoadedScope(`${projectId}/${sessionId}`)
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
      pageRef.current = { key: '', offset: 0, hasOlder: false, loading: false, limit: getMessageHistoryPageSize() }
    }
  }, [sessionId, projectId])

  const loadOlderHistory = useCallback(async (beforePrepend?: () => void) => {
    const currentSessionId = messageSessionId || sessionId
    const page = pageRef.current
    if (!currentSessionId || !projectId || page.key !== `${projectId}/${currentSessionId}`
      || page.loading || !page.hasOlder) return
    page.loading = true
    try {
      page.limit = getMessageHistoryPageSize()
      const detail = await chatSessionApi.get(currentSessionId, projectId, page.limit, page.offset)
      if (pageRef.current !== page) return
      const messages = detail.messages || []
      page.offset += messages.length
      page.hasOlder = messages.length === page.limit
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

  const loadMessageEvents = useCallback(async (messageId: string, query?: FileChangesQuery, preview = false) => {
    const currentSessionId = messageSessionId || sessionId
    if (!currentSessionId || !projectId) return
    if (query) return chatSessionApi.messageEvents(currentSessionId, messageId, projectId, 0, undefined, query)
    const store = useChatSessionStore.getState()
    const message = store.sessions[currentSessionId]?.messages.find((item) => item.id === messageId)
    if (!message?.event_detail?.available || message.event_detail.loaded || message.event_detail.loading) return
    if (preview && message.event_detail.preview_loaded) return
    store.setMessageEventLoading(currentSessionId, messageId, true)
    try {
      // Opening a running conversation only needs a recent preview. Never
      // drain its entire journal just to populate a collapsed process header.
      let cursor = 0
      let complete = false
      const events = [] as NonNullable<typeof message.events>
      while (!complete) {
        const page = await chatSessionApi.messageEvents(currentSessionId, messageId, projectId, cursor, preview ? 2 : undefined, undefined, preview)
        events.push(...page.events.map((event) => ({
          ...event,
          type: event.type || '',
          data: event.data || {},
        })))
        complete = page.complete || page.next_cursor === null
        if (preview) break
        if (!complete) {
          const nextCursor = page.next_cursor
          if (nextCursor === null || nextCursor === cursor) {
            throw new Error('Event detail cursor did not advance')
          }
          cursor = nextCursor
        }
      }
      store.setMessageEventDetails(currentSessionId, messageId, events, {
        complete: !preview,
        next_cursor: null,
        preview,
      })
    } catch (reason) {
      store.setMessageEventLoading(
        currentSessionId, messageId, false,
        reason instanceof Error ? reason.message : t('chatSession.loadFailed'),
      )
    }
  }, [sessionId, messageSessionId, projectId, t])

  return { loadMessageEvents, loadOlderHistory, historyError, historyLoading, historyReady, retryHistory }
}
