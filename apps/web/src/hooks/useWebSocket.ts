/**
 * useWebSocket — WebSocket connection with auto-reconnect.
 *
 * Connects to the daemon's /ws endpoint. Forwards incoming events
 * to the task store. Reconnects with exponential backoff on disconnect.
 */

import { useEffect, useRef, useCallback } from 'react'
import { useTaskStore } from '../stores/taskStore'

const WS_RECONNECT_BASE_MS = 1000
const WS_RECONNECT_MAX_MS = 30000

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = useRef(0)
  const handleEvent = useTaskStore((s) => s.handleWsEvent)

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`)

    ws.onopen = () => {
      console.log('[WS] connected')
      reconnectAttemptRef.current = 0
    }

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data)
        handleEvent(event)
      } catch (err) {
        console.warn('[WS] invalid message:', err)
      }
    }

    ws.onclose = () => {
      console.log('[WS] disconnected, scheduling reconnect')
      scheduleReconnect()
    }

    ws.onerror = () => {
      ws.close()
    }

    wsRef.current = ws
  }, [handleEvent])

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) return
    const delay = Math.min(
      WS_RECONNECT_BASE_MS * 2 ** reconnectAttemptRef.current,
      WS_RECONNECT_MAX_MS,
    )
    reconnectAttemptRef.current++
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null
      connect()
    }, delay)
  }, [connect])

  const send = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      wsRef.current?.close()
    }
  }, [connect])

  return { send }
}
