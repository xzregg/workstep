import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
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


test('pseudo elements remain customizable and keep the pseudo element last', () => {
  const input = { ...skin(), styles: { 'provider-protocol-switch::after': { hover: { backgroundColor: '#aabbcc' } } } }
  const css = compileSkin(input)
  assert.match(css, /:hover:not\([^{}]+::after\{background-color:#aabbcc/)
})
