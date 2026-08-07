/**
 * useWebSocket — WebSocket connection with auto-reconnect.
 *
 * Connects to the daemon's /ws endpoint. Forwards incoming events
 * to the task store. Reconnects with exponential backoff on disconnect.
 */

import { useEffect, useRef, useCallback } from 'react'
import { useTaskStore } from '../stores/taskStore'
import { useWorkflowGenStore } from '../stores/workflowGenStore'
import { useProjectStore } from '../stores/projectStore'

const WS_RECONNECT_BASE_MS = 1000
const WS_RECONNECT_MAX_MS = 30000

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const handleEvent = useTaskStore((s) => s.handleWsEvent)
  const handleGenEvent = useWorkflowGenStore((s) => s.handleWsEvent)

  const send = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

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
        // A reconnect (e.g. daemon restart) may have changed persisted task
        // state; re-fetch so the board reflects recovered runs immediately.
        const projectId = useProjectStore.getState().activeProject?.id
        if (projectId) void useTaskStore.getState().fetchTasks(projectId)
      }
      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data)
          if (parsed.session_id) handleGenEvent(parsed)
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
  }, [handleEvent])

  return { send }
}
