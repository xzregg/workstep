import { useSyncExternalStore } from 'react'
import { gatewayWorkspacePath } from '../../utils/gatewayWorkspacePath'

const preferenceKey = () => 'workstep.digital-person.wake-enabled' + gatewayWorkspacePath()
const soundPreferenceKey = () => 'workstep.digital-person.wake-sound' + gatewayWorkspacePath()
const greetingPreferenceKey = () => 'workstep.digital-person.wake-greeting' + gatewayWorkspacePath()
const preferenceChanged = 'workstep:wake-preference-changed'
const fallback = new Map<string, boolean>()
export const wakeGreetingMaxLength = 40

export function getWakeEnabled() {
  const key = preferenceKey()
  try { return localStorage.getItem(key) === 'true' }
  catch { return fallback.get(key) ?? false }
}

export function subscribeWakeEnabled(listener: () => void) {
  const storageChanged = (event: StorageEvent) => {
    if (event.key === preferenceKey() || event.key === null) listener()
  }
  window.addEventListener(preferenceChanged, listener)
  window.addEventListener('storage', storageChanged)
  return () => {
    window.removeEventListener(preferenceChanged, listener)
    window.removeEventListener('storage', storageChanged)
  }
}

export function setWakeEnabled(enabled: boolean) {
  const key = preferenceKey()
  try { localStorage.setItem(key, String(enabled)) } catch { fallback.set(key, enabled) }
  window.dispatchEvent(new Event(preferenceChanged))
}

export function useWakeEnabled() {
  return useSyncExternalStore(subscribeWakeEnabled, getWakeEnabled, () => false)
}

// Read legacy preferences only to populate the draft before the host's first feedback save.
export function getLegacyWakeSoundEnabled() {
  try { return localStorage.getItem(soundPreferenceKey()) !== 'false' }
  catch { return true }
}

export function getLegacyWakeGreeting() {
  try { return (localStorage.getItem(greetingPreferenceKey()) ?? '').slice(0, wakeGreetingMaxLength) }
  catch { return '' }
}

let testOwner: symbol | null = null
const testListeners = new Set<() => void>()
export const getWakeTest = () => testOwner
export function subscribeWakeTest(listener: () => void) {
  testListeners.add(listener)
  return () => { testListeners.delete(listener) }
}

export function setWakeTest(owner: symbol, active: boolean) {
  if (active ? testOwner !== null : testOwner !== owner) return
  testOwner = active ? owner : null
  testListeners.forEach(listener => listener())
}

export function useWakeTest() {
  return useSyncExternalStore(subscribeWakeTest, getWakeTest, () => null)
}
