import { gatewayResourceUrl } from '../utils/gatewayWorkspacePath'
import { useCallback, useEffect, useRef, useState } from 'react'
import { shareApi, type ReviewRun, type ShareMeta, type SharedTask, type TaskArtifact, type TaskArtifactInputSnapshot } from '../api/client'
import { ApiError } from '../api/transport'
import type { SharedTaskApi } from '../api/share'
import { useI18n } from '../i18n'
import { mergeLoadedTaskMessageEvents } from '../pages/taskHistoryModel'
import { applySharedMessageEvent, capSharedHistoryEvents, mergeSharedHistorySnapshot } from '../pages/sharedTaskMessages'

export type SharePhase =
  | { kind: 'loading-meta' }
  | { kind: 'need-password'; meta: ShareMeta }
  | { kind: 'unlocking'; meta: ShareMeta; password: string }
  | { kind: 'loading-task' }
  | { kind: 'ready'; sessionToken: string }
  | { kind: 'error'; message: string }

/** Owns public share access, the initial snapshot, and its live subscription. */
export function useSharedTaskSession(token?: string, api: SharedTaskApi = shareApi, { live = true }: { live?: boolean } = {}) {
  const { t } = useI18n()
  const [phase, setPhase] = useState<SharePhase>({ kind: 'loading-meta' })
  const [meta, setMeta] = useState<ShareMeta | null>(null)
  const [task, setTask] = useState<SharedTask | null>(null)
  const [messages, setMessages] = useState<any[]>([])
  const [artifacts, setArtifacts] = useState<TaskArtifact[]>([])
  const [artifactDirectory, setArtifactDirectory] = useState('')
  const [inputSnapshots, setInputSnapshots] = useState<TaskArtifactInputSnapshot[]>([])
  const [reviews, setReviews] = useState<ReviewRun[]>([])
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [wsStatus, setWsStatus] = useState<'disconnected' | 'connecting' | 'live'>('disconnected')
  const [revision, setRevision] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const scopeVersion = useRef(0)
  const olderInFlight = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)
  const reunlockAttemptsRef = useRef(0)
  const requestedDetails = useRef(new Set<string>())
  const detailsInFlight = useRef(new Set<string>())
  const latestTask = useRef(task)
  latestTask.current = task

  const loadWithSession = useCallback(async (sessionToken: string, version = scopeVersion.current) => {
    if (!token || version !== scopeVersion.current) return
    setPhase({ kind: 'loading-task' })
    const [taskData, historyData, artifactsData, reviewsData] = await Promise.all([
      api.task(token, sessionToken),
      api.history(token, sessionToken),
      api.artifacts(token, sessionToken),
      api.reviews(token, sessionToken).catch(() => ({ reviews: [] })),
    ])
    if (version !== scopeVersion.current) return
    setTask(taskData)
    setMessages(historyData.messages.map(capSharedHistoryEvents))
    setNextOffset('next_offset' in historyData && historyData.next_offset != null ? Number(historyData.next_offset) : null)
    setArtifacts(artifactsData.artifacts)
    setArtifactDirectory(artifactsData.artifact_directory || '')
    setInputSnapshots(artifactsData.input_snapshots || [])
    setReviews(reviewsData.reviews || [])
    setPhase({ kind: 'ready', sessionToken })
  }, [api, token])

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
    const version = scopeVersion.current
    try {
      const { session_token } = await api.unlock(token, '')
      await loadWithSession(session_token, version)
    } catch (reason) {
      if (version !== scopeVersion.current) return
      setPhase({ kind: 'error', message: reason instanceof Error ? reason.message : String(reason) })
    }
  }, [api, token, loadWithSession, t])

  useEffect(() => {
    if (!token) return
    let cancelled = false
    setPhase({ kind: 'loading-meta' })
    setTask(null); setMessages([]); setArtifacts([]); setReviews([]); setNextOffset(null)
    olderInFlight.current = false; setLoadingOlder(false)
    requestedDetails.current.clear(); detailsInFlight.current.clear()
    api.meta(token).then(async (shareMeta) => {
      if (cancelled) return
      setMeta(shareMeta)
      if (api.restoreSession) {
        try {
          const session = await api.restoreSession(token)
          if (!cancelled) await loadWithSession(session.session_token)
          return
        } catch (reason) {
          if (!(reason instanceof ApiError) || reason.status !== 401) throw reason
        }
      }
      if (cancelled) return
      if (shareMeta.has_password) {
        setPhase({ kind: 'need-password', meta: shareMeta })
        return
      }
      setPhase({ kind: 'unlocking', meta: shareMeta, password: '' })
      api.unlock(token, '').then(({ session_token }) => {
        if (!cancelled) return loadWithSession(session_token)
      }).catch((reason: Error) => {
        if (cancelled) return
        if (/401/i.test(reason.message)) void recoverSession(shareMeta)
        else setPhase({ kind: 'error', message: reason.message })
      })
    }).catch((reason: Error) => {
      if (!cancelled) setPhase({ kind: 'error', message: reason.message })
    })
    return () => { cancelled = true; scopeVersion.current += 1 }
  }, [api, token, revision, loadWithSession, recoverSession])

  const unlock = useCallback(async () => {
    if (!token || !meta || !password) return
    if (password.length < 4) {
      setError(t('share.passwordTooShort'))
      return
    }
    setError(null)
    setPhase({ kind: 'unlocking', meta, password })
    const version = scopeVersion.current
    try {
      const { session_token } = await api.unlock(token, password)
      await loadWithSession(session_token, version)
    } catch (reason) {
      if (version !== scopeVersion.current) return
      const message = reason instanceof Error ? reason.message : String(reason)
      if (reason instanceof ApiError && [401, 403].includes(reason.status) || /401/i.test(message)) {
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
  }, [api, token, meta, password, t, loadWithSession, recoverSession])

  useEffect(() => {
    if (phase.kind !== 'ready' || !token || !live) return
    const sessionToken = phase.sessionToken
    let closed = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let backoffMs = 500
    let snapshotInFlight = false
    let snapshotAgain = false
    const refreshSnapshot = async () => {
      if (snapshotInFlight) { snapshotAgain = true; return }
      snapshotInFlight = true
      try {
        do {
          snapshotAgain = false
          const [fresh, history, review, output] = await Promise.all([
            api.task(token, sessionToken), api.history(token, sessionToken),
            api.reviews(token, sessionToken), api.artifacts(token, sessionToken),
          ])
          if (closed) return
          latestTask.current = fresh
          setTask(fresh)
          setMessages(previous => mergeSharedHistorySnapshot(previous, history.messages))
          setReviews(review.reviews)
          setArtifacts(output.artifacts)
          setArtifactDirectory(output.artifact_directory || '')
          setInputSnapshots(output.input_snapshots || [])
        } while (snapshotAgain && !closed)
      } finally { snapshotInFlight = false }
    }

    const applyEvent = (event: any) => {
      const eventType = event?.type
      setMessages((previous) => applySharedMessageEvent(previous, event))
      if (
        eventType === 'TEXT_MESSAGE_END' ||
        eventType === 'TEXT_MESSAGE_START' ||
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
        void refreshSnapshot().catch(() => { /* retry on reconnect or the next status */ })
      }
    }

    const connect = () => {
      if (closed) return
      setWsStatus('connecting')
      const url = api.buildWsUrl(sessionToken)
      if (url === null) return
      const ws = new WebSocket(gatewayResourceUrl(url))
      wsRef.current = ws
      ws.onopen = () => {
        if (closed) return
        setWsStatus('live')
        backoffMs = 500
        void refreshSnapshot().catch(() => { /* retry on the next status */ })
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

    if (api.buildWsUrl(sessionToken) === null) {
      let timer: ReturnType<typeof setTimeout> | null = null
      let polling = false
      const schedule = () => {
        if (closed || document.visibilityState === 'hidden') return
        const activeStatuses = ['running', 'reviewing', 'retrying', 'rework']
        const current = latestTask.current
        const active = activeStatuses.includes(current?.status || '')
          || current?.steps?.some(step => activeStatuses.includes(step.status))
        timer = setTimeout(() => { timer = null; void poll() }, active ? 2000 : 30000)
      }
      const poll = async () => {
        if (closed || polling || document.visibilityState === 'hidden') return
        polling = true
        try {
          await refreshSnapshot()
          if (!closed) setWsStatus('live')
        } catch (reason) {
          if (!closed) {
            setWsStatus('disconnected')
            if (reason && typeof reason === 'object' && 'status' in reason
                && [401, 403, 404].includes(Number(reason.status))) {
              setTask(null); setMessages([]); setArtifacts([]); setReviews([])
              setPhase({ kind: 'error', message: t('share.sessionExpired') })
              return
            }
          }
        } finally { polling = false }
        schedule()
      }
      const onVisibilityChange = () => {
        if (timer) { clearTimeout(timer); timer = null }
        if (document.visibilityState !== 'hidden') void poll()
      }
      document.addEventListener('visibilitychange', onVisibilityChange)
      schedule()
      return () => {
        closed = true
        if (timer) clearTimeout(timer)
        document.removeEventListener('visibilitychange', onVisibilityChange)
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
  }, [api, phase, token, recoverSession, meta, live])

  const refreshTask = useCallback(async () => {
    if (!token || phase.kind !== 'ready') return
    const version = scopeVersion.current
    const fresh = await api.task(token, phase.sessionToken)
    if (version === scopeVersion.current) setTask(fresh)
  }, [api, token, phase])

  const appendOptimisticMessage = useCallback((message: any) => {
    setMessages((current) => [...current, message])
  }, [])

  const loadMessageEvents = useCallback(async (messageId: string) => {
    if (!token || phase.kind !== 'ready') return
    const message = messages.find((item) => item.id === messageId)
    if (!message?.event_detail?.available || message.event_detail.loaded || message.event_detail.loading
      || detailsInFlight.current.has(messageId)) return
    const version = scopeVersion.current
    requestedDetails.current.add(messageId)
    detailsInFlight.current.add(messageId)
    setMessages((current) => current.map((item) => item.id === messageId
      ? { ...item, event_detail: { ...item.event_detail, loading: true, error: '' } }
      : item))
    try {
      let cursor = message.event_detail.loaded_cursor ?? 0
      let lastEventSeq = cursor
      let complete = false
      const events: any[] = []
      let nextCursor: number | null = null
      while (!complete) {
        const page = await api.messageEvents(token, phase.sessionToken, messageId, cursor)
        events.push(...page.events)
        complete = page.complete || page.next_cursor === null
        nextCursor = page.next_cursor
        lastEventSeq = page.last_event_seq ?? nextCursor ?? message.event_detail.last_event_seq ?? lastEventSeq
        if (!complete) {
          if (nextCursor === cursor) throw new Error('Event detail cursor did not advance')
          cursor = nextCursor!
        }
      }
      if (version !== scopeVersion.current) return
      setMessages((current) => mergeLoadedTaskMessageEvents(
        current, messageId, events, { complete, next_cursor: nextCursor, last_event_seq: lastEventSeq },
      ))
    } catch (reason) {
      if (version !== scopeVersion.current) return
      const error = reason instanceof Error ? reason.message : String(reason)
      setMessages((current) => current.map((item) => item.id === messageId
        ? { ...item, event_detail: { ...item.event_detail, loading: false, error } }
        : item))
    } finally {
      if (version === scopeVersion.current) detailsInFlight.current.delete(messageId)
    }
  }, [api, messages, phase, token])

  useEffect(() => {
    for (const message of messages) {
      if (requestedDetails.current.has(message.id) && !message.event_detail?.loaded
        && !message.event_detail?.loading && !message.event_detail?.error) {
        void loadMessageEvents(message.id)
      }
    }
  }, [messages, loadMessageEvents])

  const loadOlderHistory = useCallback(async () => {
    if (!token || phase.kind !== 'ready' || nextOffset === null || olderInFlight.current) return
    const version = scopeVersion.current
    olderInFlight.current = true; setLoadingOlder(true); setError(null)
    try {
      const page = await api.history(token, phase.sessionToken, 100, nextOffset)
      if (version !== scopeVersion.current) return
      setMessages(current => {
        const known = new Set(current.map(message => message.id))
        return [...page.messages.filter(message => !known.has(message.id)).map(capSharedHistoryEvents), ...current]
      })
      setNextOffset('next_offset' in page && page.next_offset != null ? Number(page.next_offset) : null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { if (version === scopeVersion.current) { olderInFlight.current = false; setLoadingOlder(false) } }
  }, [api, token, phase, nextOffset])

  const retry = useCallback(() => {
    setTask(null); setMessages([]); setArtifacts([]); setReviews([]); setError(null)
    reunlockAttemptsRef.current = 0; setRevision(current => current + 1)
  }, [])

  return {
    retry, loadOlderHistory: nextOffset === null ? undefined : loadOlderHistory, loadingOlder,
    phase, meta, task, messages, artifacts, artifactDirectory, inputSnapshots, reviews, wsStatus,
    password, setPassword, error, unlock, refreshTask, appendOptimisticMessage, loadMessageEvents,
  }
}
