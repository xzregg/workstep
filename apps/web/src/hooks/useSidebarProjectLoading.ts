import { useEffect, useReducer } from 'react'
import { useProjectStore } from '../stores/projectStore'
import { useChatListStore } from '../stores/chatSessionStore'
import { useGatewaySessionStore } from '../stores/gatewaySessionStore'
import { useWsSubscriptionStore } from './useWebSocket'

/** Selection loads once; another click retries. No timers or recovery listeners. */
export function useSidebarProjectLoading(activeProjectId: string) {
  const [reloadVersion, reload] = useReducer((version: number) => version + 1, 0)

  useEffect(() => {
    if (!useGatewaySessionStore.getState().session?.host_project_id) {
      void useProjectStore.getState().fetchProjects()
    }
  }, [])

  useEffect(() => {
    const project = useProjectStore.getState().projects.find(p => p.id === activeProjectId)
    const remote = project?.type === 'remote'
    useWsSubscriptionStore.setState({ remoteProjectIds: remote ? [activeProjectId] : [] })
    let active = true
    const load = async () => {
      if (!project || ['revoked', 'expired', 'invalid'].includes(project.access_status ?? '')) return
      const chats = useChatListStore.getState()
      if (chats.listLoadingByProject[activeProjectId]) return
      await chats.fetchSessions(activeProjectId, true)
      if (active && remote && !useChatListStore.getState().listErrorByProject[activeProjectId]) {
        // Read the snapshot once after authentication, including before WS startup.
        await useProjectStore.getState().fetchRemoteProject(activeProjectId)
      }
    }
    void load()
    return () => {
      active = false
      useWsSubscriptionStore.setState({ remoteProjectIds: [] })
    }
  }, [activeProjectId, reloadVersion])

  return reload
}
