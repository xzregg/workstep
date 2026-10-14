import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'vite'

test('production portal and shared device styles retain queries supported by older Android WebViews', async () => {
 const result = await build({
  root: fileURLToPath(new URL('..', import.meta.url)),
  logLevel: 'silent',
  build: { write: false },
 })
 const bundles = Array.isArray(result) ? result : [result]
 const css = bundles.flatMap(bundle => 'output' in bundle ? bundle.output : [])
  .flatMap(asset => asset.type === 'asset' && asset.fileName.endsWith('.css') ? [String(asset.source)] : [])
  .join('\n')
 assert.ok(css.includes('.gateway-portal-header'), 'build must include the portal header')
 assert.ok(css.includes('.gateway-grant-picker'), 'build must include the grant group/member split layout')
 assert.ok(css.includes('.gateway-grant-groups'), 'build must include bounded group tree styling')
 assert.ok(css.includes('.gateway-instance-tabs'), 'build must include shared device tabs')
 assert.match(css, /max-width:\s*1023px/)
 assert.match(css, /max-width:\s*520px/)
 const mediaQueries = css.match(/@media[^{}]+/g) ?? []
 assert.ok(mediaQueries.length > 0)
 for (const query of mediaQueries) {
  assert.doesNotMatch(query, /(?:width|height)\s*[<>]=?\s*\d/, 'embedded browsers must not receive range media queries')
 }
})
