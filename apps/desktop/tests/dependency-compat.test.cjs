const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')
const { createRequire } = require('node:module')
const { FileMatcher } = require('app-builder-lib/out/fileMatcher')

test('security-updated matcher preserves package inclusion and exclusions', () => {
  const source = path.resolve('runtime')
  const matcher = new FileMatcher(source, path.resolve('dist'), value => value, [
    '**/*', '!**/*.map', '!**/.env*', '!**/plans/**',
  ])
  const filter = matcher.createFilter()
  const stat = { isDirectory: () => false }
  assert.equal(filter(path.join(source, 'src/main.cjs'), stat), true)
  assert.equal(filter(path.join(source, 'src/main.cjs.map'), stat), false)
  assert.equal(filter(path.join(source, '.env.local'), stat), false)
  assert.equal(filter(path.join(source, 'plans/draft.md'), stat), false)
})

test('macOS universal matcher retains basename and glob behavior', () => {
  const requireUniversal = createRequire(require.resolve('@electron/universal'))
  const { minimatch } = requireUniversal('minimatch')
  assert.equal(minimatch('lib/native.node', '*.node', { matchBase: true }), true)
  assert.equal(minimatch('lib/native.js', '*.node', { matchBase: true }), false)
  assert.equal(minimatch('Contents/Info.plist', '**/Info.plist'), true)
})
