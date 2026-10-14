import { useSyncExternalStore } from 'react'
import { ApiError, request } from '../api/transport'
import { skinsApi } from '../api/skins'
import { languagesApi } from '../api/languages'
import { useLocaleStore } from '../i18n'
import { builtinLocales, validateLanguage, type BuiltinLocale } from '../i18n/languagePack'
import { defaultSkin } from '../skins/contract'
import { committedSkin, initializeSkinPreference, saveSkin, SKIN_LIFECYCLE_EVENT } from '../skins/runtime'
import { appearanceScope, setAppearanceScope } from './appearanceStorage'
import { APPEARANCE_PREFERENCE_EVENT, initializeFontSizePreference, loadFontSizePreference, saveFontSizePreference, type FontSizePreference } from './fontSizePreference'
import { initializeFontFamilyPreference, loadFontFamilyPreference, saveFontFamilyPreference, type FontFamilyPreference } from './fontFamilyPreference'

interface Selection { skin_id: string; language: string; font_family: FontFamilyPreference; font_size: FontSizePreference }
interface PersonalAppearance { scope: string | null; preferences: Selection | null }
type SyncState = { status: 'local' | 'saved' | 'saving' | 'error'; error: string }
let state: SyncState = { status: 'local', error: '' }
const listeners = new Set<() => void>()
export const appearanceSyncState = () => state
export const useAppearanceSyncState = () => useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, appearanceSyncState)
function status(value: SyncState) { state = value; listeners.forEach(listener => listener()) }
let generation = 0
let detach = () => {}
let pending: Promise<void> | null = null
let dirty: Partial<Selection> = {}
let observed: Selection | null = null
let writable = false

function selection(): Selection {
  const locale = useLocaleStore.getState()
  const confirmed = locale.previous ?? locale
  return {
    skin_id: committedSkin().manifest.id,
    language: confirmed.language ? 'pack:' + confirmed.language.manifest.id : confirmed.locale,
    font_family: loadFontFamilyPreference(), font_size: loadFontSizePreference(),
  }
}

function collect() {
  if (!writable || !observed) return
  const next = selection()
  for (const key of Object.keys(next) as (keyof Selection)[]) {
    if (next[key] !== observed[key]) Object.assign(dirty, { [key]: next[key] })
  }
  observed = next
  if (Object.keys(dirty).length) void drain()
}

/** Serialize PATCHes; edits made during a write are sent in the following write. */
function drain(): Promise<void> {
  if (pending) return pending
  if (!writable || !Object.keys(dirty).length) return Promise.resolve()
  const current = generation
  pending = Promise.resolve().then(async () => {
    while (current === generation && Object.keys(dirty).length) {
      const patch = dirty; dirty = {}
      status({status:'saving', error:''})
      try {
        const response = await request<PersonalAppearance>('/appearance/preferences', {method:'PATCH', headers: {'X-Appearance-Scope': appearanceScope()!}, body:JSON.stringify(patch)})
        if (current !== generation) return
        if (response.scope !== appearanceScope()) throw new Error('个人外观身份已变化，请刷新后重试')
      } catch (error) {
        if (current !== generation) return
        if (error instanceof ApiError && error.status === 409) writable = false
        dirty = {...patch, ...dirty}
        status({status:'error', error:String(error instanceof Error ? error.message : error)})
        return
      }
    }
    if (current === generation) status({status:'saved', error:''})
  }).finally(() => { if (current === generation) pending = null })
  return pending
}

export async function flushAppearancePreferences(): Promise<void> {
  await Promise.resolve()
  collect()
  await drain()
}

export async function retryAppearancePreferences() {
  if (writable) await flushAppearancePreferences()
  else await initializeAppearancePreferences()
}

export function stopAppearancePreferences() {
  ++generation; detach(); detach = () => {}; pending = null; dirty = {}; observed = null; writable = false
  setAppearanceScope(null)
}

export async function initializeAppearancePreferences() {
  stopAppearancePreferences()
  const current = generation
  // Reset before an identity request. An unavailable identity must not inherit
  // the last account's cached language, skin or fonts.
  setAppearanceScope('pending')
  useLocaleStore.getState().setLocale('zh-CN')
  saveFontSizePreference('standard'); saveFontFamilyPreference('system'); saveSkin(defaultSkin(), 'load')
  let response: PersonalAppearance
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 10000)
  try {
    response = await request<PersonalAppearance>('/appearance/preferences', {signal:controller.signal})
    if (current !== generation) return
  } catch (error) {
    status({status:'error', error:String(error instanceof Error ? error.message : error)})
    return
  } finally {
    window.clearTimeout(timeout)
  }
  setAppearanceScope(response.scope)
  // Rehydrate now that the authenticated cache scope is known.
  await useLocaleStore.persist.rehydrate()
  if (current !== generation) return
  if (!response.scope || !response.preferences) {
    initializeFontSizePreference(); initializeFontFamilyPreference(); initializeSkinPreference()
    status({status:'local', error:''})
    return
  }
  const saved = response.preferences
  let skin = defaultSkin()
  if (saved.skin_id !== 'default') {
    try { skin = await skinsApi.get(saved.skin_id) } catch { /* Missing packages recover to default. */ }
  }
  if (current !== generation) return
  saveSkin(skin, 'load')
  saveFontSizePreference(saved.font_size); saveFontFamilyPreference(saved.font_family)
  useLocaleStore.getState().setLocale(builtinLocales.includes(saved.language as BuiltinLocale) ? saved.language : 'zh-CN')
  if (saved.language.startsWith('pack:')) {
    try {
      const language = validateLanguage(await languagesApi.get(saved.language.slice(5)))
      if (current !== generation) return
      useLocaleStore.getState().previewLanguage(language)
      useLocaleStore.getState().confirmPreview()
    } catch { /* Removed or invalid language packages recover to a built-in language. */ }
  }
  if (current !== generation) return
  if (new URLSearchParams(window.location.search).get('skin') === 'default') saveSkin(defaultSkin(), 'restore')
  if (new URLSearchParams(window.location.search).get('language') === 'default') useLocaleStore.getState().setLocale('zh-CN')
  observed = selection(); writable = true
  status({status:'saved', error:''})
  // Events from skin application precede its commit; collect after that stack.
  const changed = () => queueMicrotask(collect)
  const unsubscribe = useLocaleStore.subscribe(changed)
  window.addEventListener(APPEARANCE_PREFERENCE_EVENT, changed)
  window.addEventListener(SKIN_LIFECYCLE_EVENT, changed)
  detach = () => {
    unsubscribe()
    window.removeEventListener(APPEARANCE_PREFERENCE_EVENT, changed)
    window.removeEventListener(SKIN_LIFECYCLE_EVENT, changed)
  }
  // URL recovery is an explicit user choice and should survive the next visit.
  const params = new URLSearchParams(window.location.search)
  if (params.get('skin') === 'default') dirty.skin_id = 'default'
  if (params.get('language') === 'default') dirty.language = 'zh-CN'
  await flushAppearancePreferences()
}
