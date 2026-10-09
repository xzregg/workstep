const assert = require('node:assert/strict')
const test = require('node:test')

const {
  RELEASES_URL,
  createUpdateChecker,
  releaseStatus,
} = require('../src/desktop-update.cjs')

test('release status only reports a strictly newer GitHub release', () => {
  assert.deepEqual(releaseStatus('1.0.9', { tag_name: 'v1.0.10', html_url: RELEASES_URL }, 100), {
    currentVersion: '1.0.9', latestVersion: '1.0.10', updateAvailable: true,
    releaseUrl: RELEASES_URL, checkedAt: 100,
  })
  assert.equal(releaseStatus('1.0.9', { tag_name: 'v1.0.9' }, 100).updateAvailable, false)
  assert.equal(releaseStatus('1.0.9', { tag_name: 'v1.0.8' }, 100).updateAvailable, false)
})

test('automatic checks reuse a result for 24 hours while manual checks refresh', async () => {
  let now = 1_000_000
  let requests = 0
  let saved = null
  const checker = createUpdateChecker({
    currentVersion: '1.0.9', now: () => now,
    readCache: async () => saved,
    writeCache: async value => { saved = value },
    fetchRelease: async () => { requests += 1; return { tag_name: 'v1.0.10', html_url: RELEASES_URL } },
  })

  assert.equal((await checker.check()).source, 'network')
  assert.equal((await checker.check()).source, 'cache')
  assert.equal(requests, 1)
  assert.equal((await checker.check({ force: true })).source, 'network')
  assert.equal(requests, 2)
  now += 24 * 60 * 60 * 1000 + 1
  assert.equal((await checker.check()).source, 'network')
  assert.equal(requests, 3)
})

test('invalid cached data is ignored', async () => {
  let requests = 0
  const checker = createUpdateChecker({
    currentVersion: '1.0.9', now: () => 90_000_000,
    readCache: async () => ({ checkedAt: 'today', latestVersion: '1.0.10' }),
    writeCache: async () => undefined,
    fetchRelease: async () => { requests += 1; return { tag_name: 'v1.0.9' } },
  })
  assert.equal((await checker.check()).source, 'network')
  assert.equal(requests, 1)
})
