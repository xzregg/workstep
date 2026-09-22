import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyFontSizePreference,
  FONT_SIZE_STORAGE_KEY,
  loadFontSizePreference,
  saveFontSizePreference,
} from '../src/utils/fontSizePreference.ts'

function createStorage(initialValue: string | null = null) {
  let value = initialValue
  return {
    getItem(key: string) {
      assert.equal(key, FONT_SIZE_STORAGE_KEY)
      return value
    },
    setItem(key: string, nextValue: string) {
      assert.equal(key, FONT_SIZE_STORAGE_KEY)
      value = nextValue
    },
  }
}

test('font size preference loads a valid saved value and rejects unknown values', () => {
  assert.equal(loadFontSizePreference(createStorage('large')), 'large')
  assert.equal(loadFontSizePreference(createStorage('oversized')), 'standard')
  assert.equal(loadFontSizePreference(createStorage()), 'standard')
})

test('saving a font size preference persists and applies it to the document root', () => {
  const storage = createStorage()
  const target = { dataset: {} as Record<string, string> }

  saveFontSizePreference('extraLarge', storage, target)

  assert.equal(loadFontSizePreference(storage), 'extraLarge')
  assert.equal(target.dataset.fontSize, 'extraLarge')
})

test('applying a font size preference exposes it as a root data attribute', () => {
  const target = { dataset: {} as Record<string, string> }

  applyFontSizePreference('small', target)

  assert.equal(target.dataset.fontSize, 'small')
})
