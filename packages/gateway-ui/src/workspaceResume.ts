const PAGE_KEY = 'workstep:last-workspace-page'

export type WorkspacePage = { deviceId: string; next: string }

function validPage(deviceId: string, next: string): boolean {
  if (!deviceId || /[/?#\\\s]/.test(deviceId) || /[\\\x00-\x20]/.test(next)) return false
  const match = /^(chat|tasks)\?([^#]*)$/.exec(next)
  if (!match) return false
  const query = new URLSearchParams(match[2])
  return !!query.get('project') && !!query.get(match[1] === 'chat' ? 'session' : 'task')
}

export function rememberWorkspacePage(url: string, storage: Storage): void {
  try {
    const page = new URL(url)
    const match = /^\/workspace\/([^/]+)\/(chat|tasks)$/.exec(page.pathname)
    if (!match) return
    const deviceId = decodeURIComponent(match[1])
    const next = match[2] + page.search
    if (validPage(deviceId, next)) {
      storage.setItem(PAGE_KEY, JSON.stringify({ deviceId, next }))
      storage.setItem('workstep-device', deviceId)
    }
  } catch { /* Browsing still works when local storage is unavailable. */ }
}

export function restoredWorkspacePage(storage: Storage): WorkspacePage | null {
  try {
    const page = JSON.parse(storage.getItem(PAGE_KEY) || 'null') as WorkspacePage | null
    return page && validPage(page.deviceId, page.next) ? page : null
  } catch { return null }
}
