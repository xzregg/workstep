import { useCallback, useEffect, useLayoutEffect, useRef, useState,
  type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react'
import { taskApi } from '../api/client'
import { loadTaskHistoryWithRetry, mergeLoadedTaskMessageEvents,
  mergeRefreshedTaskHistory } from '../pages/taskDetailChat'

const PAGE_SIZE = 300

interface TaskHistoryOptions {
  taskId: string
  projectId: string
  userMessageEvents: number
  reviewEventSignal: string
  chatScrollRef: RefObject<HTMLDivElement | null>
  shouldFollowMessagesRef: MutableRefObject<boolean>
  lastProgrammaticScrollTopRef: MutableRefObject<number>
}

export interface TaskHistoryState {
  historyMessages: any[]
  setHistoryMessages: Dispatch<SetStateAction<any[]>>
  historyLoading: boolean
  loadOlderHistory: () => Promise<void>
  loadMessageEvents: (messageId: string) => Promise<void>
}

/** Owns persisted task messages, older pages, detail events, and refresh signals. */
export function useTaskHistory({ taskId, projectId, userMessageEvents,
  reviewEventSignal, chatScrollRef, shouldFollowMessagesRef,
  lastProgrammaticScrollTopRef }: TaskHistoryOptions): TaskHistoryState {
  const [historyMessages, setHistoryMessages] = useState<any[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const offsetRef = useRef(0)
  const hasOlderRef = useRef(true)
  const olderLoadingRef = useRef(false)
  const prependScrollHeightRef = useRef<number | null>(null)
  const fetchedRef = useRef('')
  const refreshSeenRef = useRef<{ key: string; user: number; review: string } | null>(null)
  const eventDetailInFlightRef = useRef(new Set<string>())

  useEffect(() => {
    if (!taskId || !projectId) {
      fetchedRef.current = ''
      return
    }
    const fetchKey = `${taskId}-${projectId}`
    if (fetchedRef.current === fetchKey) return
    const controller = new AbortController()
    setHistoryLoading(true)
    offsetRef.current = 0
    hasOlderRef.current = true
    olderLoadingRef.current = false
    setHistoryMessages([])
    void loadTaskHistoryWithRetry(
      () => taskApi.history(taskId, projectId, PAGE_SIZE, 0), controller.signal,
    ).then((response) => {
      if (controller.signal.aborted || !response) return
      const messages = response.messages || []
      offsetRef.current = messages.length
      hasOlderRef.current = messages.length === PAGE_SIZE
      setHistoryMessages((current) => mergeRefreshedTaskHistory(current, messages))
      fetchedRef.current = fetchKey
    }).finally(() => {
      if (!controller.signal.aborted) setHistoryLoading(false)
    })
    return () => controller.abort()
  }, [taskId, projectId])

  const loadOlderHistory = useCallback(async () => {
    if (!taskId || !projectId || historyLoading || olderLoadingRef.current || !hasOlderRef.current) return
    olderLoadingRef.current = true
    shouldFollowMessagesRef.current = false
    const container = chatScrollRef.current
    prependScrollHeightRef.current = container?.scrollHeight ?? null
    const offset = offsetRef.current
    try {
      const response = await taskApi.history(taskId, projectId, PAGE_SIZE, offset)
      const olderMessages = response.messages || []
      offsetRef.current += olderMessages.length
      hasOlderRef.current = olderMessages.length === PAGE_SIZE
      setHistoryMessages((current) => {
        const currentIds = new Set(current.map((message) => String(message.id)))
        return [...olderMessages.filter((message: any) => !currentIds.has(String(message.id))), ...current]
      })
    } catch {
      prependScrollHeightRef.current = null
    } finally {
      olderLoadingRef.current = false
    }
  }, [historyLoading, projectId, taskId, chatScrollRef, shouldFollowMessagesRef])

  useLayoutEffect(() => {
    const previousHeight = prependScrollHeightRef.current
    const container = chatScrollRef.current
    if (previousHeight === null || !container) return
    const nextTop = container.scrollTop + container.scrollHeight - previousHeight
    container.scrollTop = nextTop
    lastProgrammaticScrollTopRef.current = nextTop
    prependScrollHeightRef.current = null
  }, [historyMessages, chatScrollRef, lastProgrammaticScrollTopRef])

  const loadMessageEvents = useCallback(async (messageId: string) => {
    if (!taskId || !projectId || eventDetailInFlightRef.current.has(messageId)) return
    const message = historyMessages.find((item) => item.id === messageId)
    if (!message?.event_detail?.available || message.event_detail.loaded || message.event_detail.loading) return
    eventDetailInFlightRef.current.add(messageId)
    setHistoryMessages((current) => current.map((item) => item.id === messageId
      ? { ...item, event_detail: { ...item.event_detail, loading: true, error: '' } } : item))
    try {
      let cursor = 0
      let complete = false
      const loadedEvents: any[] = []
      let nextCursor: number | null = null
      while (!complete) {
        const page = await taskApi.messageEvents(taskId, messageId, projectId, cursor)
        loadedEvents.push(...page.events)
        complete = page.complete || page.next_cursor === null
        nextCursor = page.next_cursor
        if (!complete) {
          if (nextCursor === null || nextCursor === cursor) throw new Error('Event detail cursor did not advance')
          cursor = nextCursor
        }
      }
      setHistoryMessages((current) => mergeLoadedTaskMessageEvents(
        current, messageId, loadedEvents, { complete, next_cursor: nextCursor },
      ))
    } catch (reason) {
      const error = reason instanceof Error ? reason.message : String(reason)
      setHistoryMessages((current) => current.map((item) => item.id === messageId
        ? { ...item, event_detail: { ...item.event_detail, loading: false, error } } : item))
    } finally {
      eventDetailInFlightRef.current.delete(messageId)
    }
  }, [historyMessages, projectId, taskId])

  // Remote user messages and review events both request the first page.
  useEffect(() => {
    if (!taskId || !projectId) {
      refreshSeenRef.current = null
      return
    }
    const key = `${taskId}-${projectId}`
    const previous = refreshSeenRef.current
    refreshSeenRef.current = { key, user: userMessageEvents, review: reviewEventSignal }
    // The initial history request already includes signals present when the panel opens.
    if (!previous || previous.key !== key
      || (previous.user === userMessageEvents && previous.review === reviewEventSignal)) return
    let active = true
    const timer = window.setTimeout(() => {
      taskApi.history(taskId, projectId, PAGE_SIZE, 0)
        .then((response) => {
          if (active) setHistoryMessages((current) => mergeRefreshedTaskHistory(current, response.messages || []))
        }).catch(() => undefined)
    }, 50)
    return () => { active = false; window.clearTimeout(timer) }
  }, [projectId, taskId, userMessageEvents, reviewEventSignal])

  return { historyMessages, setHistoryMessages, historyLoading, loadOlderHistory, loadMessageEvents }
}
