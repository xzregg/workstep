import assert from 'node:assert/strict'
import test from 'node:test'

import { replaceLightDarkWithLightFallback } from '../src/utils/htmlPreviewCompat.ts'

test('replaces unsupported light-dark colors while preserving nested color functions', () => {
  assert.equal(
    replaceLightDarkWithLightFallback(
      ':root{--surface:light-dark(rgb(255 255 255 / 96%), rgb(54 54 54 / 96%));color:light-dark(#111,#eee)}',
    ),
    ':root{--surface:rgb(255 255 255 / 96%);color:#111}',
  )
})

test('leaves malformed and unrelated CSS intact', () => {
  assert.equal(replaceLightDarkWithLightFallback('a{color:red}'), 'a{color:red}')
  assert.equal(
    replaceLightDarkWithLightFallback('a{color:light-dark(red)}'),
    'a{color:light-dark(red)}',
  )
})
