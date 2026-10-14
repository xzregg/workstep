import { installDomEnvironment } from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import { initializeAppearancePreferences, flushAppearancePreferences, stopAppearancePreferences, appearanceSyncState } from '../src/utils/appearancePreferences'
import { appearanceStorageKey } from '../src/utils/appearanceStorage'
import { saveFontSizePreference, loadFontSizePreference } from '../src/utils/fontSizePreference'
import { saveFontFamilyPreference } from '../src/utils/fontFamilyPreference'
import { useLocaleStore } from '../src/i18n'
import { previewSkin, cancelSkinPreview, saveSkin, currentSkin } from '../src/skins/runtime'
import { defaultSkin } from '../src/skins/contract'
import { skinsApi } from '../src/api/skins'
import { languagesApi } from '../src/api/languages'
import { languageCatalog, validateLanguage } from '../src/i18n/languagePack'

test('shared skin selection follows the user across browsers; previews and old public caches do not sync', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('http://localhost/workspace/device/tasks')
  const oldFetch = globalThis.fetch, oldGet = skinsApi.get
  let user = 'alice'
  const defaults = { skin_id: 'default', language: 'zh-CN', font_size: 'standard', font_family: 'system' }
  const selections = { alice: { ...defaults, skin_id: 'ocean', font_size: 'large', language: 'en-US' }, bob: { ...defaults } }
  const patches: Record<string, unknown>[] = []
  skinsApi.get = async id => ({ ...defaultSkin(), manifest: { ...defaultSkin().manifest, id }, tokens: { accent: '#123456' } })
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'PATCH') { const patch = JSON.parse(String(init.body)); patches.push(patch); Object.assign(selections[user], patch) }
    return Response.json({ scope: user, preferences: selections[user] })
  }
  try {
    localStorage.setItem('workstep.fontSize', 'extraLarge')
    await initializeAppearancePreferences()
    assert.equal(currentSkin().manifest.id, 'ocean')
    assert.equal(loadFontSizePreference(), 'large')
    assert.equal(useLocaleStore.getState().locale, 'en-US')
    previewSkin({ ...defaultSkin(), manifest: { ...defaultSkin().manifest, id: 'preview' }, layout: { fontSize: 'small' } })
    cancelSkinPreview()
    await flushAppearancePreferences()
    assert.equal(patches.length, 0)
    saveFontSizePreference('small'); saveFontFamilyPreference('serif')
    useLocaleStore.getState().setLocale('ja-JP')
    saveSkin({ ...defaultSkin(), manifest: { ...defaultSkin().manifest, id: 'shared' } })
    await flushAppearancePreferences()
    assert.equal(selections.alice.skin_id, 'shared')
    assert.equal(selections.alice.font_size, 'small')
    assert.equal(selections.alice.language, 'ja-JP')
    assert.equal(selections.bob.skin_id, 'default')
    user = 'bob'
    await initializeAppearancePreferences()
    assert.equal(loadFontSizePreference(), 'standard')
    assert.equal(currentSkin().manifest.id, 'default')
    assert.equal(useLocaleStore.getState().locale, 'zh-CN')
    localStorage.clear() // Another browser / phone, with no personal cache.
    user = 'alice'
    await initializeAppearancePreferences()
    assert.equal(currentSkin().manifest.id, 'shared')
    assert.equal(loadFontSizePreference(), 'small')
    assert.equal(useLocaleStore.getState().locale, 'ja-JP')
    assert.ok(appearanceStorageKey('workstep.fontSize').includes('alice'))
  } finally {
    stopAppearancePreferences(); globalThis.fetch = oldFetch; skinsApi.get = oldGet
    await window.happyDOM.close()
  }
})

test('failed saves can be retried; queued edits preserve the latest choice', async () => {
  const { window } = installDomEnvironment()
  const oldFetch = globalThis.fetch
  const preferences = { skin_id: 'default', language: 'zh-CN', font_size: 'standard', font_family: 'system' }
  let fail = true
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'PATCH') {
      if (fail) return Response.json({detail:'disk unavailable'}, {status:503})
      await new Promise(resolve => setTimeout(resolve, 5))
      Object.assign(preferences, JSON.parse(String(init.body)))
    }
    return Response.json({scope:'alice', preferences})
  }
  try {
    await initializeAppearancePreferences()
    saveFontSizePreference('large')
    await flushAppearancePreferences()
    assert.equal(appearanceSyncState().status, 'error')
    fail = false
    saveFontSizePreference('extraLarge'); saveFontFamilyPreference('serif')
    await flushAppearancePreferences()
    assert.equal(preferences.font_size, 'extraLarge')
    assert.equal(preferences.font_family, 'serif')
    assert.equal(appearanceSyncState().status, 'saved')
  } finally { stopAppearancePreferences(); globalThis.fetch = oldFetch; await window.happyDOM.close() }
})

test('deleted packages fall back without rewriting stored selections or exposing another account', async () => {
  const { window } = installDomEnvironment()
  const oldFetch = globalThis.fetch, oldGet = skinsApi.get
  let fail = false
  globalThis.fetch = async () => {
    if (fail) throw new Error('offline')
    return Response.json({scope:'alice', preferences:{skin_id:'deleted', language:'zh-CN', font_size:'large', font_family:'system'}})
  }
  skinsApi.get = async () => { throw new Error('removed') }
  try {
    await initializeAppearancePreferences()
    assert.equal(currentSkin().manifest.id, 'default')
    assert.equal(loadFontSizePreference(), 'large')
    fail = true
    await initializeAppearancePreferences()
    assert.equal(currentSkin().manifest.id, 'default')
    assert.equal(loadFontSizePreference(), 'standard')
    assert.equal(appearanceSyncState().status, 'error')
  } finally { stopAppearancePreferences(); globalThis.fetch = oldFetch; skinsApi.get = oldGet; await window.happyDOM.close() }
})

test('language packages remain shared while preview confirmation and storage failure affect only the selection', async () => {
  const { window } = installDomEnvironment()
  const oldFetch = globalThis.fetch, oldGet = languagesApi.get
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!
  const language = validateLanguage({manifest:{schema_version:1, id:'spanish', locale:'es-ES', name:'西班牙语', native_name:'Español', version:'1.0.0', direction:'ltr', fallback_locale:'en-US', catalog_revision:languageCatalog.revision}, revision:'a'.repeat(64), messages:Object.fromEntries(languageCatalog.required_keys.map(key => [key, languageCatalog.messages[key]]))})
  const preferences = {skin_id:'default', language:'pack:spanish', font_size:'standard', font_family:'system'}
  const patches = []
  languagesApi.get = async () => language
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'PATCH') { patches.push(JSON.parse(String(init.body))); Object.assign(preferences, patches.at(-1)) }
    return Response.json({scope:'language-user', preferences})
  }
  try {
    Object.defineProperty(globalThis, 'localStorage', {configurable:true, get:() => {throw new Error('blocked')}})
    await initializeAppearancePreferences()
    assert.equal(useLocaleStore.getState().language?.manifest.id, 'spanish')
    useLocaleStore.getState().previewLanguage({...language, manifest:{...language.manifest, id:'another'}})
    await flushAppearancePreferences()
    assert.equal(patches.length, 0)
    useLocaleStore.getState().cancelPreview()
    await flushAppearancePreferences()
    assert.equal(patches.length, 0)
    useLocaleStore.getState().previewLanguage({...language, manifest:{...language.manifest, id:'another'}})
    useLocaleStore.getState().confirmPreview()
    saveFontSizePreference('extraLarge')
    await flushAppearancePreferences()
    assert.equal(preferences.language, 'pack:another')
    assert.equal(preferences.font_size, 'extraLarge')
  } finally {
    stopAppearancePreferences(); Object.defineProperty(globalThis, 'localStorage', oldStorage)
    globalThis.fetch = oldFetch; languagesApi.get = oldGet; await window.happyDOM.close()
  }
})

test('unmanaged access restores the existing browser preferences without a server write', async () => {
  const { window } = installDomEnvironment()
  const oldFetch = globalThis.fetch
  localStorage.setItem('workstep.fontSize', 'large')
  localStorage.setItem('workstep.locale', JSON.stringify({state:{locale:'ja-JP', language:null}, version:0}))
  globalThis.fetch = async (_input, init) => {
    assert.notEqual(init?.method, 'PATCH')
    return Response.json({scope:null, preferences:null})
  }
  try {
    await initializeAppearancePreferences()
    assert.equal(loadFontSizePreference(), 'large')
    assert.equal(useLocaleStore.getState().locale, 'ja-JP')
    assert.equal(appearanceSyncState().status, 'local')
  } finally { stopAppearancePreferences(); globalThis.fetch = oldFetch; await window.happyDOM.close() }
})
