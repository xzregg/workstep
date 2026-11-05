import { useSyncExternalStore } from 'react'
import type { SkinDocument } from './contract'
import { appearanceCache, appearanceScope } from '../utils/appearanceStorage'
import { gatewayWorkspacePath } from '../utils/gatewayWorkspacePath'

const changeEvent = 'workstep:skin-script-preference'
export const skinScriptScope = () => appearanceScope() ?? `local:${gatewayWorkspacePath()}`
const preferenceKey = (skin: SkinDocument) => `workstep:skin-scripts:${skinScriptScope()}:${skin.manifest.id}`

function enabled(skin: SkinDocument) {
  if (!skin.script) return false
  const saved = appearanceCache.getItem(preferenceKey(skin))
  if (saved !== null) return saved === 'enabled'
  // Honor existing permission for this exact package until the user changes the switch.
  return appearanceCache.getItem(`workstep:skin-code:${skinScriptScope()}:${skin.manifest.id}:${skin.revision}`) === 'enabled'
}

function subscribe(listener: () => void) {
  window.addEventListener(changeEvent, listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(changeEvent, listener)
    window.removeEventListener('storage', listener)
  }
}

export function setSkinScriptsEnabled(skin: SkinDocument, value: boolean) {
  if (!skin.script) return
  appearanceCache.setItem(preferenceKey(skin), value ? 'enabled' : 'disabled')
  window.dispatchEvent(new Event(changeEvent))
}

export function useSkinScriptsEnabled(skin: SkinDocument) {
  return useSyncExternalStore(subscribe, () => enabled(skin), () => false)
}
