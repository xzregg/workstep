import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { saveFontSizePreference, loadFontSizePreference } from '../src/utils/fontSizePreference'
import { saveFontFamilyPreference, loadFontFamilyPreference } from '../src/utils/fontFamilyPreference'
import { compileSkin, defaultSkin, skinContract, resolvedSkinLayout } from '../src/skins/contract'
import { applySkin, restoreDefaultSkin, previewSkin, cancelSkinPreview, saveSkin, initializeSkinPreference } from '../src/skins/runtime'

const skin = () => ({ ...defaultSkin(), manifest: { id: 'ocean', name: '海洋', version: '1', schema_version: 1, color_scheme: 'dark' as const }, revision: 'abc', tokens: { bg: '#102030' }, styles: { button: { base: { borderRadius: '12px' }, hover: { color: '#fff' } } }, layout: { sidebarSide: 'right' as const }, asset_base: '/api/skins/assets/abc' })

test('compiler scopes presentation overrides, mobile inheritance and backgrounds', () => {
  const input = { ...skin(), mobile: { tokens: { accent: '#ff0000' }, styles: {} } }
  const css = compileSkin(input)
  assert.match(css, /data-skin-id/)
  assert.match(css, /--bg:#102030/)
  assert.match(css, /border-radius:12px/)
  assert.match(css, /:hover/)
  assert.match(css, /max-width: 1023px/)
  assert.ok(skinContract.parts['input'])
  assert.ok(skinContract.parts['chat-input-config-row'])
})

test('invalid structural overrides and injected CSS are rejected', () => {
  assert.throws(() => compileSkin({ ...skin(), tokens: { bg: 'red;display:none' } }))
  assert.throws(() => compileSkin({ ...skin(), tokens: { bg: '12px' } }))
  assert.throws(() => compileSkin({ ...skin(), styles: { button: { base: { display: 'none' } } } } as never))
})

test('preview cancellation and refresh restore without replacing business DOM', () => {
  localStorage.clear()
  restoreDefaultSkin()
  const input = document.body.appendChild(document.createElement('textarea'))
  input.value = 'draft'
  saveSkin(skin())
  previewSkin({ ...skin(), tokens: { bg: '#fff' }, revision: 'preview' })
  assert.equal(document.documentElement.dataset.skinRevision, 'preview')
  cancelSkinPreview()
  assert.equal(document.documentElement.dataset.skinRevision, 'abc')
  assert.equal(input.value, 'draft')
  applySkin(defaultSkin())
  initializeSkinPreference()
  assert.equal(document.documentElement.dataset.skinId, 'ocean')
  restoreDefaultSkin()
  assert.equal(document.documentElement.dataset.skinId, 'default')
  assert.equal(document.getElementById('workstep-skin-style'), null)
  input.remove()
})


test('PC and mobile layouts inherit shared values and may override independently', () => {
  const input = { ...skin(), layout: { sidebarWidth: 300 }, desktop: { layout: { sidebarSide: 'right' as const } }, mobile: { layout: { sidebarSide: 'left' as const, engineAppearance: 'list' as const } } }
  compileSkin(input)
  assert.equal(resolvedSkinLayout(input, false).sidebarSide, 'right')
  assert.equal(resolvedSkinLayout(input, true).sidebarSide, 'left')
  assert.equal(resolvedSkinLayout(input, true).sidebarWidth, 300)
  assert.throws(() => compileSkin({ ...input, mobile: { layout: { sidebarWidth: 1000 } } }))
})

test('soft background glow is a declarative layout option that resets with the default skin', () => {
  const input = { ...skin(), layout: { backgroundGlow: 'accent' as const } }
  compileSkin(input)
  previewSkin(input)
  assert.equal(document.documentElement.dataset.skinGlow, 'accent')
  restoreDefaultSkin()
  assert.equal(document.documentElement.dataset.skinGlow, 'none')
})


test('pseudo elements remain customizable and keep the pseudo element last', () => {
  const input = { ...skin(), styles: { 'provider-protocol-switch::after': { hover: { backgroundColor: '#aabbcc' } } } }
  const css = compileSkin(input)
  assert.match(css, /:hover:not\([^{}]+::after\{background-color:#aabbcc/)
})

test('skin typography previews, cancels, commits and keeps manual controls authoritative', () => {
  localStorage.clear(); restoreDefaultSkin()
  saveFontSizePreference('small'); saveFontFamilyPreference('pingfang')
  const proposal = { ...skin(), tokens: { 'font-body': 'Georgia, serif', 'font-display': 'Georgia, serif' }, layout: { fontSize: 'large' as const } }
  previewSkin(proposal)
  assert.equal(document.documentElement.dataset.fontSize, 'large')
  assert.equal(loadFontSizePreference(), 'small')
  cancelSkinPreview()
  assert.equal(document.documentElement.dataset.fontSize, 'small')
  assert.equal(document.documentElement.style.getPropertyValue('--font-body'), '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif')
  saveSkin(proposal)
  assert.equal(loadFontSizePreference(), 'large')
  assert.equal(loadFontFamilyPreference(), 'system')
  saveFontFamilyPreference('pingfang')
  assert.equal(document.documentElement.style.getPropertyPriority('--font-body'), 'important')
  saveFontSizePreference('extraLarge')
  applySkin(defaultSkin()); initializeSkinPreference()
  assert.equal(document.documentElement.dataset.fontSize, 'extraLarge', 'a later explicit device preference survives reload')
  assert.throws(() => compileSkin({ ...proposal, layout: { fontSize: 'giant' } } as never))
  restoreDefaultSkin()
})

test('send icons preserve legacy defaults and desktop/mobile inheritance', () => {
 assert.equal(resolvedSkinLayout(defaultSkin()).composerSendIcon,'send')
 const draft={...skin(),layout:{composerSendIcon:'arrow-up' as const},mobile:{layout:{composerSendIcon:'arrow-right' as const}}}
 compileSkin(draft)
 assert.equal(resolvedSkinLayout(draft,false).composerSendIcon,'arrow-up')
 assert.equal(resolvedSkinLayout(draft,true).composerSendIcon,'arrow-right')
 assert.throws(()=>compileSkin({...draft,layout:{composerSendIcon:'trash'}} as never))
})
