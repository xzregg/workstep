type PlatformStatus = { initialized: boolean; company_display_name?: string }
let pending: Promise<PlatformStatus> | undefined

// Share concurrent portal/title status reads without caching stale settings.
export function loadPlatformStatus(): Promise<PlatformStatus> {
  if (!pending) {
    pending = fetch('/api/platform/status').then(async response => {
      if (!response.ok) throw new Error('无法检查平台状态，请刷新重试。')
      return await response.json() as PlatformStatus
    }).finally(() => { pending = undefined })
  }
  return pending
}

export const companyNameChanged = 'gateway-company-name-changed'
export function publishCompanyName(name: string) {
  window.dispatchEvent(new window.CustomEvent(companyNameChanged, { detail: name }))
}
