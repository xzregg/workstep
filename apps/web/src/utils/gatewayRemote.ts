import { gatewayWorkspacePath } from './gatewayWorkspacePath'
export function gatewayRemotePortalUrl(): string | null {
  if (typeof window === 'undefined') return null
  if (gatewayWorkspacePath()) return window.location.origin + '/devices'
  const hostname = window.location.hostname
  const dot = hostname.indexOf('.')
  const protocol = window.location.protocol
  if (dot < 3 || !hostname.startsWith('d-')) return null
  const gatewayHost = hostname.slice(dot + 1)
  const local = gatewayHost === 'localhost' || gatewayHost.endsWith('.localhost')
  if (protocol !== 'https:' && !(protocol === 'http:' && local)) return null
  const port = window.location.port ? `:${window.location.port}` : ''
  return `${protocol}//${gatewayHost}${port}/devices`
}

export function isGatewayRemoteBrowser(): boolean {
  return gatewayRemotePortalUrl() !== null
}
