import { applyFontSizePreference, loadFontSizePreference, saveFontSizePreference } from '../utils/fontSizePreference'
import { applyFontFamilyPreference, loadFontFamilyPreference, saveFontFamilyPreference } from '../utils/fontFamilyPreference'
import { useSyncExternalStore } from 'react'
import { compileSkin, defaultSkin, resolvedSkinLayout, type SkinDocument } from './contract'
import { gatewayWorkspacePath } from '../utils/gatewayWorkspacePath'
import { appearanceCache, appearanceStorageKey } from '../utils/appearanceStorage'

export const SKIN_EVENT = 'workstep:skin-change'
export const SKIN_LIFECYCLE_EVENT = 'workstep:skin-lifecycle'
export type SkinLifecycle = 'load' | 'preview' | 'apply' | 'cancel-preview' | 'restore' | 'error'
function lifecycle(type: SkinLifecycle, skin: SkinDocument, error?: string) {
  window.dispatchEvent(new window.CustomEvent(SKIN_LIFECYCLE_EVENT, { detail: { type, id: skin.manifest.id, revision: skin.revision, ...(error ? { error } : {}) } }))
}
export const skinStorageKey = () => appearanceStorageKey('workstep.skin.v1:' + gatewayWorkspacePath())
let active = defaultSkin()
let committed = active
let previewing = false
let mediaTarget: Window | null = null
let detachMedia: (() => void) | null = null
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const useActiveSkin = () => useSyncExternalStore(subscribe, () => active, () => active)
export const useSkinPreviewing = () => useSyncExternalStore(subscribe, () => previewing, () => false)
export const currentSkin = () => active
export const committedSkin = () => committed

function applyLayout(skin: SkinDocument) {
  const root = document.documentElement
  const layout = resolvedSkinLayout(skin, window.matchMedia('(max-width: 1023px)').matches)
  root.dataset.skinSidebar = layout.sidebarSide
  root.dataset.skinSteps = layout.stepsSide
  root.dataset.skinDensity = layout.density
  root.dataset.skinComposer = layout.composerToolsPosition
  root.dataset.skinEngine = layout.engineAppearance
  root.dataset.skinGlow = layout.backgroundGlow
  root.style.setProperty('--skin-content-width', layout.contentWidth + 'px')
  root.style.setProperty('--skin-split-handle-width', layout.splitHandleWidth + 'px')
  return layout
}
function wireViewport() {
  if (mediaTarget === window) return
  detachMedia?.()
  mediaTarget = window
  const query = window.matchMedia('(max-width: 1023px)')
  const change = () => {
    const layout = applyLayout(active)
    window.dispatchEvent(new window.CustomEvent(SKIN_EVENT, { detail: { id: active.manifest.id, revision: active.revision, layout, reason: 'viewport' } }))
  }
  query.addEventListener('change', change)
  detachMedia = () => query.removeEventListener('change', change)
}

export function applySkin(skin: SkinDocument, reason: SkinLifecycle = 'load') {
  let css: string
  try { css = compileSkin(skin) } catch (error) { lifecycle('error', skin?.manifest ? skin : defaultSkin(), String(error)); throw error }
  // Validate before changing a working skin.
  if (skin.manifest.id === 'default') document.getElementById('workstep-skin-style')?.remove()
  else {
    let style = document.getElementById('workstep-skin-style') as HTMLStyleElement | null
    if (!style) { style = document.createElement('style'); style.id = 'workstep-skin-style'; document.head.appendChild(style) }
    style.textContent = css
  }
  const root = document.documentElement
  root.dataset.skinId = skin.manifest.id
  root.dataset.skinRevision = skin.revision
  root.dataset.skinScheme = skin.manifest.color_scheme
  const layout = applyLayout(skin)
  const typographyChange = reason === 'preview' || reason === 'apply'
  applyFontSizePreference(typographyChange && layout.fontSize !== 'inherit' ? layout.fontSize : loadFontSizePreference())
  const variant = window.matchMedia('(max-width: 1023px)').matches ? skin.mobile : skin.desktop
  const changesFamily = Object.hasOwn(skin.tokens, 'font-body') || Object.hasOwn(variant?.tokens ?? {}, 'font-body')
  applyFontFamilyPreference(typographyChange && changesFamily ? 'system' : loadFontFamilyPreference())
  wireViewport()
  active = skin
  for (const listener of listeners) listener()
  window.dispatchEvent(new window.CustomEvent(SKIN_EVENT, { detail: { id: skin.manifest.id, revision: skin.revision, layout: resolvedSkinLayout(skin, window.matchMedia('(max-width: 1023px)').matches), reason } }))
  lifecycle(reason, skin)
}

export function saveSkin(skin: SkinDocument, reason: SkinLifecycle = 'apply') {
  applySkin(skin, reason)
  const compact = window.matchMedia('(max-width: 1023px)').matches
  const size = resolvedSkinLayout(skin, compact).fontSize
  if (size !== 'inherit') saveFontSizePreference(size)
  if (Object.hasOwn(skin.tokens, 'font-body') || Object.hasOwn((compact ? skin.mobile : skin.desktop)?.tokens ?? {}, 'font-body')) saveFontFamilyPreference('system')
  committed = skin; previewing = false
  appearanceCache.setItem(skinStorageKey(), JSON.stringify(skin))
  for (const listener of listeners) listener()
}
export function previewSkin(skin: SkinDocument) {
  applySkin(skin, 'preview'); previewing = true
  for (const listener of listeners) listener()
}
export function cancelSkinPreview() {
  applySkin(committed, 'cancel-preview'); previewing = false
  for (const listener of listeners) listener()
}
export function restoreDefaultSkin() { saveSkin(defaultSkin(), 'restore') }

export function initializeSkinPreference() {
  try {
    if (new URLSearchParams(window.location.search).get('skin') === 'default') { restoreDefaultSkin(); return }
    const stored = appearanceCache.getItem(skinStorageKey())
    committed = stored ? JSON.parse(stored) : defaultSkin()
    applySkin(committed)
  } catch { restoreDefaultSkin() }
}
