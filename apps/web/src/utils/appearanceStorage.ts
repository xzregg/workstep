/** Personal caches never fall back to a previous user's device-wide values. */
let scope: string | null = null
export function setAppearanceScope(value: string | null) { scope = value }
export function appearanceScope() { return scope }
export function appearanceStorageKey(key: string) { return scope ? `${key}:user-device:${scope}` : key }
const memory = new Map<string, string>()
export const appearanceCache = {
  getItem: (key: string) => { try { return localStorage.getItem(key) } catch { return memory.get(key) ?? null } },
  setItem: (key: string, value: string) => { memory.set(key, value); try { localStorage.setItem(key, value) } catch { /* Use memory until storage is available. */ } },
  removeItem: (key: string) => { memory.delete(key); try { localStorage.removeItem(key) } catch { /* Storage may be blocked. */ } },
}
export const appearanceStorage = {
  getItem: (key: string) => appearanceCache.getItem(appearanceStorageKey(key)),
  setItem: (key: string, value: string) => appearanceCache.setItem(appearanceStorageKey(key), value),
  removeItem: (key: string) => appearanceCache.removeItem(appearanceStorageKey(key)),
}
