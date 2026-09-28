export function gatewayRemotePortalUrl(): string | null {
  if (typeof window === 'undefined') return null
  const hostname = window.location.hostname
  const dot = hostname.indexOf('.')
  if (window.location.protocol !== 'https:' || dot < 3 || !hostname.startsWith('d-')) return null
  return `https://${hostname.slice(dot + 1)}/devices`
}

export function isGatewayRemoteBrowser(): boolean {
  return gatewayRemotePortalUrl() !== null
}
