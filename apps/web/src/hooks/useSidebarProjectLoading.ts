import { useEffect, useReducer } from 'react'
import { useProjectStore } from '../stores/projectStore'
import { useGatewaySessionStore } from '../stores/gatewaySessionStore'
import { useWsSubscriptionStore } from './useWebSocket'

/** Selection loads project metadata; conversations load only on section expansion. */
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
    if (remote && !['revoked', 'expired', 'invalid'].includes(project.access_status ?? '')) {
      void useProjectStore.getState().fetchRemoteProject(activeProjectId)
    }
    return () => {
      useWsSubscriptionStore.setState({ remoteProjectIds: [] })
    }
  }, [activeProjectId, reloadVersion])

  return reload
}
