import { useCallback, useEffect, useRef, useState } from 'react'
import { shareApi, type ReviewRun, type ShareMeta, type SharedTask, type TaskArtifact } from '../api/client'
import { useI18n } from '../i18n'
import { mergeLoadedTaskMessageEvents } from '../pages/taskHistoryModel'
import { applySharedMessageEvent, capSharedHistoryEvents } from '../pages/sharedTaskMessages'

export type SharePhase =
  | { kind: 'loading-meta' }
  | { kind: 'need-password'; meta: ShareMeta }
  | { kind: 'unlocking'; meta: ShareMeta; password: string }
  | { kind: 'loading-task' }
  | { kind: 'ready'; sessionToken: string }
  | { kind: 'error'; message: string }

/** Owns public share access, the initial snapshot, and its live subscription. */
export function useSharedTaskSession(token?: string) {
  const { t } = useI18n()
  const [phase, setPhase] = useState<SharePhase>({ kind: 'loading-meta' })
  const [meta, setMeta] = useState<ShareMeta | null>(null)
  const [task, setTask] = useState<SharedTask | null>(null)
  const [messages, setMessages] = useState<any[]>([])
  const [artifacts, setArtifacts] = useState<TaskArtifact[]>([])
  const [artifactDirectory, setArtifactDirectory] = useState('')
  const [reviews, setReviews] = useState<ReviewRun[]>([])
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [wsStatus, setWsStatus] = useState<'disconnected' | 'connecting' | 'live'>('disconnected')
  const wsRef = useRef<WebSocket | null>(null)
  const reunlockAttemptsRef = useRef(0)

  const loadWithSession = useCallback(async (sessionToken: string) => {
    if (!token) return
    setPhase({ kind: 'loading-task' })
    const [taskData, historyData, artifactsData, reviewsData] = await Promise.all([
      shareApi.task(token, sessionToken),
      shareApi.history(token, sessionToken),
      shareApi.artifacts(token, sessionToken),
      shareApi.reviews(token, sessionToken).catch(() => ({ reviews: [] })),
    ])
    setTask(taskData)
    setMessages(historyData.messages.map(capSharedHistoryEvents))
    setArtifacts(artifactsData.artifacts)
    setArtifactDirectory(artifactsData.artifact_directory || '')
    setReviews(reviewsData.reviews || [])
    setPhase({ kind: 'ready', sessionToken })
  }, [token])

  const recoverSession = useCallback(async (shareMeta: ShareMeta) => {
    if (!token) return
    if (shareMeta.has_password) {
      setPhase({ kind: 'need-password', meta: shareMeta })
      return
    }
    if (reunlockAttemptsRef.current >= 2) {
      setPhase({ kind: 'error', message: t('share.sessionExpired') })
      return
    }
    reunlockAttemptsRef.current += 1
    try {
      const { session_token } = await shareApi.unlock(token, '')
      await loadWithSession(session_token)
    } catch (reason) {
      setPhase({ kind: 'error', message: reason instanceof Error ? reason.message : String(reason) })
    }
  }, [token, loadWithSession, t])

  useEffect(() => {
    if (!token) return
    let cancelled = false
    setPhase({ kind: 'loading-meta' })
    shareApi.meta(token).then((shareMeta) => {
      if (cancelled) return
      setMeta(shareMeta)
      if (shareMeta.has_password) {
        setPhase({ kind: 'need-password', meta: shareMeta })
        return
      }
      setPhase({ kind: 'unlocking', meta: shareMeta, password: '' })
      shareApi.unlock(token, '').then(({ session_token }) => {
        if (!cancelled) return loadWithSession(session_token)
      }).catch((reason: Error) => {
        if (cancelled) return
        if (/401/i.test(reason.message)) void recoverSession(shareMeta)
        else setPhase({ kind: 'error', message: reason.message })
      })
    }).catch((reason: Error) => {
      if (!cancelled) setPhase({ kind: 'error', message: reason.message })
    })
    return () => { cancelled = true }
  }, [token, loadWithSession, recoverSession])

  const unlock = useCallback(async () => {
    if (!token || !meta || !password) return
    if (password.length < 4) {
      setError(t('share.passwordTooShort'))
      return
    }
    setError(null)
    setPhase({ kind: 'unlocking', meta, password })
    try {
      const { session_token } = await shareApi.unlock(token, password)
      await loadWithSession(session_token)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      if (/401/i.test(message)) {
        if (meta.has_password) {
          setError(t('share.incorrectPassword'))
          setPhase({ kind: 'need-password', meta })
        } else {
          void recoverSession(meta)
        }
      } else {
        setPhase({ kind: 'error', message })
      }
    }
  }, [token, meta, password, t, loadWithSession, recoverSession])

  useEffect(() => {
    if (phase.kind !== 'ready' || !token) return
    const sessionToken = phase.sessionToken
    let closed = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let backoffMs = 500

    const applyEvent = (event: any) => {
      const eventType = event?.type
      setMessages((previous) => applySharedMessageEvent(previous, event))
      if (
        eventType === 'status' ||
        eventType === 'RUN_STARTED' ||
        eventType === 'RUN_FINISHED' ||
        eventType === 'RUN_ERROR' ||
        eventType === 'review_status' ||
        eventType === 'review_result' ||
        eventType === 'step_retrying' ||
        event?.type === 'CUSTOM' && (
          event?.name === 'workstep.status' ||
          event?.name === 'workstep.step_retrying' ||
          event?.name === 'workstep.run_recovered' ||
          event?.name === 'workstep.review_status' ||
          event?.name === 'workstep.review_result'
        )
      ) {
        const shouldRefreshReviews = eventType === 'review_status'
          || eventType === 'review_result'
          || event?.name === 'workstep.review_status'
          || event?.name === 'workstep.review_result'
        shareApi.task(token, sessionToken).then((fresh) => {
          if (!closed) setTask(fresh)
        }).catch(() => { /* swallow */ })
        if (shouldRefreshReviews) {
          shareApi.reviews(token, sessionToken).then((fresh) => {
            if (!closed) setReviews(fresh.reviews || [])
          }).catch(() => { /* swallow */ })
        }
      }
    }

    const connect = () => {
      if (closed) return
      setWsStatus('connecting')
      const ws = new WebSocket(shareApi.buildWsUrl(sessionToken))
      wsRef.current = ws
      ws.onopen = () => {
        if (closed) return
        setWsStatus('live')
        backoffMs = 500
      }
      ws.onmessage = (event) => {
        try { applyEvent(JSON.parse(event.data)) } catch { /* ignore malformed */ }
      }
      ws.onerror = () => {
        try { ws.close() } catch { /* ignore */ }
      }
      ws.onclose = (event) => {
        if (wsRef.current === ws) wsRef.current = null
        if (closed) return
        setWsStatus('disconnected')
        if (event.code === 4401) {
          if (meta) void recoverSession(meta)
          return
        }
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          connect()
        }, backoffMs)
        backoffMs = Math.min(backoffMs * 2, 15000)
      }
    }

    connect()
    return () => {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      const ws = wsRef.current
      wsRef.current = null
      try { ws?.close() } catch { /* ignore */ }
    }
  }, [phase, token, recoverSession, meta])

  const refreshTask = useCallback(async () => {
    if (!token || phase.kind !== 'ready') return
    const fresh = await shareApi.task(token, phase.sessionToken)
    setTask(fresh)
  }, [token, phase])

  const appendOptimisticMessage = useCallback((message: any) => {
    setMessages((current) => [...current, message])
  }, [])

  const loadMessageEvents = useCallback(async (messageId: string) => {
    if (!token || phase.kind !== 'ready') return
    const message = messages.find((item) => item.id === messageId)
    if (!message?.event_detail?.available || message.event_detail.loaded || message.event_detail.loading) return
    setMessages((current) => current.map((item) => item.id === messageId
      ? { ...item, event_detail: { ...item.event_detail, loading: true, error: '' } }
      : item))
    try {
      let cursor = 0
      let complete = false
      const events: any[] = []
      let nextCursor: number | null = null
      while (!complete) {
        const page = await shareApi.messageEvents(token, phase.sessionToken, messageId, cursor)
        events.push(...page.events)
        complete = page.complete || page.next_cursor === null
        nextCursor = page.next_cursor
        if (!complete) {
          if (nextCursor === cursor) throw new Error('Event detail cursor did not advance')
          cursor = nextCursor!
        }
      }
      setMessages((current) => mergeLoadedTaskMessageEvents(
        current, messageId, events, { complete, next_cursor: nextCursor },
      ))
    } catch (reason) {
      const error = reason instanceof Error ? reason.message : String(reason)
      setMessages((current) => current.map((item) => item.id === messageId
        ? { ...item, event_detail: { ...item.event_detail, loading: false, error } }
        : item))
    }
  }, [messages, phase, token])

  return {
    phase, meta, task, messages, artifacts, artifactDirectory, reviews, wsStatus,
    password, setPassword, error, unlock, refreshTask, appendOptimisticMessage, loadMessageEvents,
  }
}
