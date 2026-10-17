import assert from 'node:assert/strict'
import test from 'node:test'

import { isolatedHtmlDocument, replaceLightDarkWithLightFallback } from '../src/utils/htmlPreviewCompat.ts'

test('isolated documents preserve authored standards or quirks mode and place policy before scripts', () => {
  const standards = isolatedHtmlDocument('\uFEFF<!DOCTYPE html><html><script>run()</script></html>')
  assert.ok(standards.startsWith('\uFEFF<!DOCTYPE html><meta'))
  assert.ok(standards.indexOf('Content-Security-Policy') < standards.indexOf('<script>run()'))
  assert.ok(!isolatedHtmlDocument('<button>Prototype</button>').includes('<!doctype'))
})

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
