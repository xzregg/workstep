import { useEffect } from 'react'
import { useManagedModeStore } from '../stores/managedModeStore'
import { isGatewayRemoteBrowser } from '../utils/gatewayRemote'

export function useManagedMode(enabled = true): boolean | null {
  const managed = useManagedModeStore(state => state.managed)
  const load = useManagedModeStore(state => state.load)
  const gatewayRemote = isGatewayRemoteBrowser()
  useEffect(() => { if (enabled && !gatewayRemote) void load() }, [gatewayRemote, load, enabled])
  return gatewayRemote ? true : managed
}
