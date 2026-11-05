import { openRemoteAccess as submitRemoteAccess } from '@workstep/gateway-ui/openRemoteAccess'

export function openRemoteAccess(access: { url: string; ticket: string; next?: string }, target?: string) {
  const url = new URL(access.url, window.location.href)
  // Workspace paths belong to this platform; preserve a direct LAN/loopback entry.
  // Dedicated device subdomains keep their separate authority.
  const gatewayUrl = /^\/workspace\/[^/]+\//.test(url.pathname)
    ? new URL(url.pathname + url.search + url.hash, window.location.origin).toString()
    : url.toString()
  submitRemoteAccess({ ...access, url: gatewayUrl }, target)
}
