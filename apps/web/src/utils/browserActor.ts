export const BROWSER_ACTOR_STORAGE_KEY = 'workstep:browser-actor:v2'

export interface BrowserActor {
  id: string
  name: string
  deviceId: string
  deviceName: string
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function storage(): StorageLike | null {
  return typeof window === 'undefined' ? null : window.localStorage
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `browser-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function defaultDeviceName(): string {
  if (typeof navigator === 'undefined') return 'Browser'
  const ua = navigator.userAgent || ''
  if (/Edg\//.test(ua)) return 'Edge'
  if (/Chrome\//.test(ua)) return 'Chrome'
  if (/Safari\//.test(ua)) return 'Safari'
  if (/Firefox\//.test(ua)) return 'Firefox'
  return 'Browser'
}

export function loadBrowserActor(target: StorageLike | null = storage()): BrowserActor | null {
  if (!target) return null
  try {
    const raw = target.getItem(BROWSER_ACTOR_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<BrowserActor>
    const id = typeof value.id === 'string' ? value.id.trim() : ''
    const name = typeof value.name === 'string' ? value.name.trim() : ''
    const deviceId = typeof value.deviceId === 'string' ? value.deviceId.trim() : ''
    const deviceName = typeof value.deviceName === 'string' ? value.deviceName.trim() : ''
    if (!id || !name || !deviceId || !deviceName) return null
    return { id, name, deviceId, deviceName }
  } catch {
    return null
  }
}

export function saveBrowserActor(
  name: string,
  device?: { deviceId?: string; deviceName?: string },
  target: StorageLike | null = storage(),
): BrowserActor | null {
  const normalized = name.trim()
  if (!target || !normalized) return null
  const existing = loadBrowserActor(target)
  const actor = {
    id: existing?.id || randomId(),
    name: normalized,
    deviceId: device?.deviceId?.trim() || existing?.deviceId || randomId(),
    deviceName: device?.deviceName?.trim() || existing?.deviceName || defaultDeviceName(),
  }
  target.setItem(BROWSER_ACTOR_STORAGE_KEY, JSON.stringify(actor))
  return actor
}

export function browserActorHeaders(
  actor: BrowserActor | null = loadBrowserActor(),
): Record<string, string> {
  if (!actor) return {}
  return {
    'X-WorkStep-Actor-Id': encodeURIComponent(actor.id),
    'X-WorkStep-Actor-Name': encodeURIComponent(actor.name),
    'X-WorkStep-Actor-Device-Id': encodeURIComponent(actor.deviceId),
    'X-WorkStep-Actor-Device-Name': encodeURIComponent(actor.deviceName),
  }
}
