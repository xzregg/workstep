import {useSyncExternalStore} from 'react'
import {gatewayWorkspacePath} from '../../utils/gatewayWorkspacePath'

type Preference = 'speakerMuted' | 'camera' | 'frontCamera' | 'microphone' | 'atlas'
const changed = 'workstep:digital-home-preference'
const fallback = new Map<string, boolean>()

export function homePreferenceScope(projectId: string) {
 return `workstep.digital-home${gatewayWorkspacePath()}:${encodeURIComponent(projectId)}`
}

export function readHomePreference(scope: string, preference: Preference) {
 const key = `${scope}:${preference}`
 if(fallback.has(key))return fallback.get(key) ?? false
 try { return localStorage.getItem(key) === 'true' }
 catch { return false }
}

export function writeHomePreference(scope: string, preference: Preference, value: boolean) {
 const key = `${scope}:${preference}`
 try {
  localStorage.setItem(key, String(value))
  fallback.delete(key)
 } catch { fallback.set(key, value) }
 window.dispatchEvent(new Event(changed))
}

function subscribe(listener: () => void) {
 window.addEventListener(changed, listener)
 window.addEventListener('storage', listener)
 return () => {
  window.removeEventListener(changed, listener)
  window.removeEventListener('storage', listener)
 }
}

export function useHomePreference(scope: string, preference: Preference) {
 return useSyncExternalStore(subscribe, () => readHomePreference(scope, preference), () => false)
}
