import { useGatewaySessionStore } from '../stores/gatewaySessionStore'
import { isGatewayRemoteBrowser } from '../utils/gatewayRemote'

/** Local and whole-device workspaces keep their existing behavior. */
export function useGatewayProjectPermissions(projectId?: string) {
  const session = useGatewaySessionStore(state => state.session)
  const bound = isGatewayRemoteBrowser() && !!session?.host_project_id
  const canEdit = !bound || (session?.host_project_id === projectId && session.access_level === 'edit')
  return { bound, canEdit, canCreateTask: canEdit && (!bound || !!session?.task_create) }
}
