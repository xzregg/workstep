type AnalyticsScript = {
  src?: string
  defer?: boolean
  dataset: Record<string, string>
}

type AnalyticsDocument = {
  createElement: (name: string) => AnalyticsScript
  head: { appendChild: (script: AnalyticsScript) => unknown }
}

export function installWebAnalytics(
  token: string | undefined,
  target: AnalyticsDocument = document as unknown as AnalyticsDocument,
): boolean {
  const normalized = token?.trim()
  if (!normalized) return false

  const script = target.createElement('script')
  script.src = 'https://static.cloudflareinsights.com/beacon.min.js'
  script.defer = true
  script.dataset.cfBeacon = JSON.stringify({ token: normalized })
  target.head.appendChild(script)
  return true
}
