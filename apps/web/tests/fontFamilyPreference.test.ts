import assert from 'node:assert/strict'
import test from 'node:test'
import { applyFontFamilyPreference, loadFontFamilyPreference, saveFontFamilyPreference, FONT_FAMILY_STORAGE_KEY } from '../src/utils/fontFamilyPreference'

test('font family survives reload and applies to body and display with a system fallback', () => {
  let stored: string | null = null
  const storage = { getItem: () => stored, setItem: (key: string, value: string) => { assert.equal(key, FONT_FAMILY_STORAGE_KEY); stored = value } }
  const values = new Map<string, string>()
  const target = { style: { setProperty: (key: string, value: string) => values.set(key, value), removeProperty: (key: string) => { values.delete(key); return '' } } }
  saveFontFamilyPreference('pingfang', storage, target)
  assert.equal(loadFontFamilyPreference(storage), 'pingfang')
  assert.match(values.get('--font-body')!, /PingFang SC.*Microsoft YaHei.*sans-serif/)
  assert.equal(values.get('--font-body'), values.get('--font-display'))
  applyFontFamilyPreference('system', target)
  assert.equal(values.size, 0, 'default lets the skin and system font stack apply')
  stored = 'unknown-font'; assert.equal(loadFontFamilyPreference(storage), 'system')
})

test('blocked storage does not prevent a font from applying', () => {
  const values = new Map<string, string>()
  const storage = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  const target = { style: { setProperty: (key: string, value: string) => values.set(key, value), removeProperty: () => '' } }
  assert.equal(loadFontFamilyPreference(storage), 'system')
  saveFontFamilyPreference('serif', storage, target)
  assert.match(values.get('--font-body')!, /serif/)
})
