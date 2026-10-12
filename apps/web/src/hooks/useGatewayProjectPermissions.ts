import { useMemo } from 'react'
import { useGatewaySessionStore } from '../stores/gatewaySessionStore'
import { isGatewayRemoteBrowser } from '../utils/gatewayRemote'
import { resolveProjectPermissions } from '../utils/projectPermissions'

/** Local and whole-device workspaces keep their existing behavior. */
export function useGatewayProjectPermissions(projectId?: string) {
  const session = useGatewaySessionStore(state => state.session)
  const remote = isGatewayRemoteBrowser()
  return useMemo(() => {
    const permissions = resolveProjectPermissions(remote, session, projectId)
    return { ...permissions, canOpenSettings: ['project.settings', 'session.config', 'action.manage', 'skill.read', 'share.create', 'share.manage'].some(permissions.can) }
  }, [remote, session, projectId])
}
