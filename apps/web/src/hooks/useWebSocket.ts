/**
 * useWebSocket — WebSocket connection with auto-reconnect.
 *
 * Connects to the daemon's /ws endpoint. Forwards incoming events
 * to the stores, and subscribes the server to a narrowed event set so
 * this client only receives what it actually renders:
 * - full streams for the task detail currently open;
 * - status-only events for every task in the current project (list refresh);
 * - session streams for active assistant chats (flow_gen / task_create /
 *   session_chat).
 * Reconnects with exponential backoff on disconnect and re-subscribes.
 */

import { useEffect, useRef, useCallback } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { useTaskStore } from '../stores/taskStore'
import { useWorkflowGenStore } from '../stores/workflowGenStore'
import { useTaskDraftStore } from '../stores/taskDraftStore'
import { useChatListStore, useChatSessionStore } from '../stores/chatSessionStore'
import { useProjectStore } from '../stores/projectStore'
import { useChannelStore } from '../stores/channelStore'

const WS_RECONNECT_BASE_MS = 1000
const WS_RECONNECT_MAX_MS = 30000

/**
 * Which task detail panels are open (full event streams). Populated by
 * pages that render a task detail (e.g. TaskList) via setDetailTaskIds.
 */
export const useWsSubscriptionStore = create<{ taskIds: string[] }>(() => ({
  taskIds: [],
}))

export function setDetailTaskIds(taskIds: string[]) {
  useWsSubscriptionStore.setState({ taskIds })
}

let notifySubscriptionChange: (() => void) | null = null

/**
 * 立即把当前订阅状态推给服务端。用于「会话创建后、引擎调用前」先完成订阅，
 * 避免服务端按 session_ids 过滤时丢掉该会话的首条事件（TEXT_MESSAGE_START 含
 * prompt），导致消息迟迟不出现、提示词丢失。
 */
export function flushWsSubscriptionNow() {
  notifySubscriptionChange?.()
}

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const handleEvent = useTaskStore((s) => s.handleWsEvent)
  const handleGenEvent = useWorkflowGenStore((s) => s.handleWsEvent)
  const handleTaskDraftEvent = useTaskDraftStore((s) => s.handleWsEvent)
  const handleChatSessionEvent = useChatSessionStore((s) => s.handleWsEvent)
  const handleChannelEvent = useChannelStore((s) => s.handleWsEvent)

  // Stable inputs for the subscription: only change when task ids / session
  // ids actually change (message chunks mutate session content, not keys).
  const detailTaskIds = useWsSubscriptionStore((s) => s.taskIds)
  const tasks = useTaskStore(useShallow((s) => s.tasks))
  const genSessionIds = useWorkflowGenStore(useShallow((s) => Object.keys(s.sessions)))
  const draftSessionIds = useTaskDraftStore(useShallow((s) => Object.keys(s.sessions)))
  const chatSessionIds = useChatSessionStore(useShallow((s) => Object.keys(s.sessions)))
  const sidebarChatSessionIds = useChatListStore(
    useShallow((s) => s.sessions.map((session) => session.id)),
  )
  const activeProjectId = useProjectStore((s) => s.activeProject?.id)

  const send = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  const buildSubscription = useCallback(() => ({
    type: 'subscribe',
    project_id: useProjectStore.getState().activeProject?.id,
    task_ids: useWsSubscriptionStore.getState().taskIds,
    status_only_task_ids: useTaskStore.getState().tasks.map((t) => t.id),
    session_ids: [...new Set([
      ...Object.keys(useWorkflowGenStore.getState().sessions),
      ...Object.keys(useTaskDraftStore.getState().sessions),
      ...Object.keys(useChatSessionStore.getState().sessions),
      ...useChatListStore.getState().sessions.map((session) => session.id),
    ])],
    channels: useProjectStore.getState().activeProject?.id ? ['channel_wechat'] : [],
  }), [])

  const flushSubscription = useCallback(() => {
    send(buildSubscription())
  }, [buildSubscription, send])

  useEffect(() => {
    notifySubscriptionChange = flushSubscription
    return () => { notifySubscriptionChange = null }
  }, [flushSubscription])

  // Re-send the subscription whenever the derived set changes. The set only
  // changes on user-driven actions (open detail, create/switch a session,
  // task list refresh) — never per event chunk — so sending immediately is
  // cheap and keeps the subscribe-before-stream race window minimal.
  useEffect(() => {
    flushSubscription()
  }, [flushSubscription, detailTaskIds, tasks, genSessionIds, draftSessionIds, chatSessionIds, sidebarChatSessionIds, activeProjectId])

  useEffect(() => {
    let active = true
    let reconnectAttempt = 0
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (!active) return
      if (
        wsRef.current?.readyState === WebSocket.OPEN ||
        wsRef.current?.readyState === WebSocket.CONNECTING
      ) return

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`)
      wsRef.current = ws

      ws.onopen = () => {
        console.log('[WS] connected')
        reconnectAttempt = 0
        // Narrow the server-side fan-out to what this client renders.
        flushSubscription()
        // A reconnect (e.g. daemon restart) may have changed persisted task
        // state; re-fetch so the board reflects recovered runs immediately.
        const projectId = useProjectStore.getState().activeProject?.id
        if (projectId) void useTaskStore.getState().fetchTasks(projectId)
      }
      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data)
          if (parsed.type === 'CUSTOM' && parsed.name === 'workstep.remote_project_status') {
            void useProjectStore.getState().fetchProjects()
            const activeProjectId = useProjectStore.getState().activeProject?.id
            if (activeProjectId && activeProjectId === parsed.value?.project_id && parsed.value?.status === 'connected') {
              void useTaskStore.getState().fetchTasks(activeProjectId)
            }
          }
          if (parsed.session_id && parsed.channel === 'flow_gen') handleGenEvent(parsed)
          if (parsed.session_id && parsed.channel === 'task_create') handleTaskDraftEvent(parsed)
          if (parsed.session_id && parsed.channel === 'session_chat') handleChatSessionEvent(parsed)
          if (parsed.channel === 'channel_wechat') handleChannelEvent(parsed)
          handleEvent(parsed)
        } catch (error) {
          console.warn('[WS] invalid message:', error)
        }
      }
      ws.onerror = () => ws.close()
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null
        if (!active || reconnectTimer) return
        const delay = Math.min(
          WS_RECONNECT_BASE_MS * 2 ** reconnectAttempt,
          WS_RECONNECT_MAX_MS,
        )
        reconnectAttempt++
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          connect()
        }, delay)
      }
    }

    connect()
    return () => {
      active = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      const ws = wsRef.current
      wsRef.current = null
      ws?.close()
    }
  }, [handleEvent, handleGenEvent, handleTaskDraftEvent, handleChatSessionEvent, handleChannelEvent, flushSubscription])

  return { send }
}
