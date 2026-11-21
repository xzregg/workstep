import { isGatewayRemoteBrowser } from './gatewayRemote'

/** Finish a local login cancellation before React starts API/WS consumers.
 * Vite serves the document itself, so the daemon cannot handle its query marker.
 */
export async function restoreLocalGatewayMode(): Promise<void> {
  const location = window.location
  const params = new URLSearchParams(location.search)
  if (params.get('gateway_auth') !== 'cancelled'
    || isGatewayRemoteBrowser()) return

  const response = await fetch('/api/gateway-platform/local-workspace', {
    method: 'POST',
    headers: { Origin: location.origin },
  })
  if (!response.ok) throw Error('Failed to return to the local workspace')
  params.delete('gateway_auth')
  const query = params.toString()
  window.history.replaceState(window.history.state, '', location.pathname + (query ? `?${query}` : '') + location.hash)
}
