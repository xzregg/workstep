import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useGatewaySessionStore } from '../stores/gatewaySessionStore'
import { gatewayWorkspacePath } from '../utils/gatewayWorkspacePath'
import { rememberWorkspaceLocation } from '../utils/gatewayWorkspaceLocation'

/** Remember router changes even when device navigation replaces this document. */
export default function GatewayWorkspaceLocation() {
  const location = useLocation()
  const session = useGatewaySessionStore(state => state.session)
  useEffect(() => {
    if (!session?.user_id || gatewayWorkspacePath() !== '/workspace/' + session.device_id) return
    rememberWorkspaceLocation(session.user_id, session.device_id,
      location.pathname.slice(1) + location.search + location.hash, session.project_id)
  }, [session?.user_id, session?.device_id, session?.project_id, location.pathname, location.search, location.hash])
  return null
}
