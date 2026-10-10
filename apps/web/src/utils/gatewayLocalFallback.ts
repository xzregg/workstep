import { isGatewayRemoteBrowser } from './gatewayRemote'

/** Finish a local login cancellation before React starts API/WS consumers.
 * Vite serves the document itself, so the daemon cannot handle its query marker.
 */
export async function restoreLocalGatewayMode(): Promise<void> {
  const location = window.location
  const params = new URLSearchParams(location.search)
  if (params.get('gateway_auth') !== 'cancelled'
    || isGatewayRemoteBrowser()) return

  const settings = await fetch('/api/gateway-platform/settings')
  if (!settings.ok) throw Error('无法读取网关设置')
  const configured = await settings.json()
  if (configured.package_locked) throw Error('此安装已绑定网关，无法切换本地模式')
  const response = await fetch('/api/gateway-platform/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: location.origin },
    body: JSON.stringify({ url: configured.url, enabled: false }),
  })
  if (!response.ok) throw Error('无法切换本地模式')
  params.delete('gateway_auth')
  const query = params.toString()
  window.history.replaceState(window.history.state, '', location.pathname + (query ? `?${query}` : '') + location.hash)
}
