/** Keep remote workspace resources on the selected device's Gateway path. */
export function gatewayWorkspacePath(): string {
  if (typeof window === 'undefined') return ''
  return window.location?.pathname?.match(/^\/workspace\/[^/]+(?=\/|$)/)?.[0] ?? ''
}

export function gatewayResourceUrl(value: string): string {
  const prefix = gatewayWorkspacePath()
  if (!prefix || value.startsWith(prefix + '/')) return value
  const socketPath = '/ws' + prefix
  if (value === '/ws' || value.startsWith('/ws?')) return socketPath + value.slice(3)
  if (value.startsWith('/api/') || value.startsWith('/assets/')) return prefix + value
  try {
    const url = new URL(value)
    if (url.host === window.location.host && ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      && (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname.startsWith('/assets/'))) {
      url.pathname = url.pathname === '/ws' ? socketPath : prefix + url.pathname
      return url.toString()
    }
  } catch { /* Relative non-resource and external URLs are unchanged. */ }
  return value
}

export function gatewayAuthenticationRedirect(response: Response): string | null {
  return response.status === 401 && response.headers.get('X-WorkStep-Gateway-Login') === '/gateway/login'
    && !gatewayWorkspacePath() ? '/gateway/login' : null
}

let redirecting = false
function handleGatewayAuthentication(response: Response): Response {
  const target = gatewayAuthenticationRedirect(response)
  if (target && typeof window !== 'undefined' && !window.workstepDesktop && !redirecting) {
    redirecting = true
    window.location.assign(target)
  }
  return response
}

export function gatewayFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (typeof input === 'string') return globalThis.fetch(gatewayResourceUrl(input), init).then(handleGatewayAuthentication)
  if (input instanceof URL) return globalThis.fetch(gatewayResourceUrl(input.toString()), init).then(handleGatewayAuthentication)
  const next = gatewayResourceUrl(input.url)
  return globalThis.fetch(next === input.url ? input : new Request(next, input), init).then(handleGatewayAuthentication)
}
