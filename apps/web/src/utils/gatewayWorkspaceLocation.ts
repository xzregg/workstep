type WorkspaceLocation = { next: string; projectId: string | null }
const routes = new Set(['', 'tasks', 'chat', 'canvas', 'git', 'statistics', 'schedules', 'file-preview'])

function safeNext(next: unknown): next is string {
  return typeof next === 'string' && !/[\\\x00-\x20\x7f]/.test(next)
    && routes.has(next.split(/[?#]/, 1)[0])
}
function storageKey(userId: string, deviceId: string) {
  return 'workstep-workspace-location:' + JSON.stringify([userId, deviceId])
}
export function rememberWorkspaceLocation(userId: string, deviceId: string, next: string, projectId: string | null) {
  if (!userId || !deviceId || !safeNext(next)) return
  try {
    localStorage.setItem(storageKey(userId, deviceId), JSON.stringify({ next, projectId }))
    sessionStorage.setItem('workstep-device', deviceId)
  } catch { /* Remembering a page is optional when browser storage is unavailable. */ }
}
export function readWorkspaceLocation(userId: string | undefined, deviceId: string): WorkspaceLocation | null {
  if (!userId) return null
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(userId, deviceId)) ?? 'null')
    return value && safeNext(value.next) && (value.projectId === null || typeof value.projectId === 'string') ? value : null
  } catch { return null }
}
