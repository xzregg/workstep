import { useEffect, useRef } from 'react'
import { useProjectStore } from '../stores/projectStore'
import { useChatListStore } from '../stores/chatSessionStore'
import { useGatewaySessionStore } from '../stores/gatewaySessionStore'
import { useWsSubscriptionStore } from './useWebSocket'

const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 60000

/** Successful loads use project events; only failed loads schedule retries. */
export function useSidebarProjectLoading(projectIdsKey: string) {
  const previousIds = useRef(new Set<string>())

  useEffect(() => {
    if (!useGatewaySessionStore.getState().session?.host_project_id) {
      void useProjectStore.getState().fetchProjects()
    }
  }, [])

  useEffect(() => {
    const ids = new Set(projectIdsKey ? projectIdsKey.split('\u0000') : [])
    const remoteIds = [...ids].filter(id => useProjectStore.getState().projects.some(p => p.id === id && p.type === 'remote'))
    useWsSubscriptionStore.setState({ remoteProjectIds: remoteIds })
    let active = true
    let busy = false
    let delay = RETRY_BASE_MS
    let timer: number | undefined
    const canRetry = (projectId: string) => {
      const project = useProjectStore.getState().projects.find(p => p.id === projectId)
      return project && project.access_status !== 'revoked' && project.access_status !== 'expired'
    }
    const needsSessions = (id: string) => {
      const chats = useChatListStore.getState()
      const project = useProjectStore.getState().projects.find(p => p.id === id)
      return Boolean(canRetry(id) && !chats.listLoadingByProject[id]
        && (chats.listErrorByProject[id] || !(id in chats.sessionsByProject)
          || (project?.type === 'remote' && project.connection_status !== 'connected')))
    }
    const loadSessions = async (id: string) => {
      const chats = useChatListStore.getState()
      if (!canRetry(id) || chats.listLoadingByProject[id]) return
      await chats.fetchSessions(id, true)
      if (active && !useChatListStore.getState().listErrorByProject[id] && remoteIds.includes(id)) {
        // One cached project snapshot covers authentication before WS startup.
        await useProjectStore.getState().fetchRemoteProject(id)
      }
    }
    const hasFailures = () => Boolean(useProjectStore.getState().loadError
      || [...ids].some(id => needsSessions(id)
        || (canRetry(id) && useProjectStore.getState().remoteLoadErrors[id])))
    const clearTimer = () => { window.clearTimeout(timer); timer = undefined }
    const retry = async (recover = false) => {
      if (!active || busy || document.visibilityState === 'hidden') return
      clearTimer()
      busy = true
      try {
        const projects = useProjectStore.getState()
        if (projects.loadError && !projects.loading) await projects.fetchProjects()
        await Promise.all([...ids].map(async id => {
          if (!canRetry(id)) return
          if (needsSessions(id) || (recover && remoteIds.includes(id))) await loadSessions(id)
          else if (projects.remoteLoadErrors[id]) await projects.fetchRemoteProject(id)
        }))
      } finally {
        busy = false
        delay = Math.min(delay * 2, RETRY_MAX_MS)
        schedule()
      }
    }
    const schedule = () => {
      if (!active || busy) return
      if (document.visibilityState === 'hidden' || !hasFailures()) {
        clearTimer()
        if (!hasFailures()) delay = RETRY_BASE_MS
        return
      }
      if (timer === undefined) timer = window.setTimeout(() => { timer = undefined; void retry() }, delay)
    }
    const unsubscribeProjects = useProjectStore.subscribe(schedule)
    const unsubscribeChats = useChatListStore.subscribe(schedule)
    for (const id of ids) {
      if (!previousIds.current.has(id) && needsSessions(id)) void loadSessions(id)
    }
    previousIds.current = ids
    schedule()
    const wake = () => {
      if (document.visibilityState === 'hidden') clearTimer()
      else void retry()
    }
    const reconnected = () => { void retry(true) }
    window.addEventListener('online', wake)
    window.addEventListener('workstep:reconnected', reconnected)
    document.addEventListener('visibilitychange', wake)
    return () => {
      active = false
      clearTimer()
      unsubscribeProjects()
      unsubscribeChats()
      useWsSubscriptionStore.setState({ remoteProjectIds: [] })
      window.removeEventListener('online', wake)
      window.removeEventListener('workstep:reconnected', reconnected)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [projectIdsKey])
}
