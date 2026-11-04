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


test('automatic checks can be disabled persistently without preventing manual checks', async () => {
  let preferences = {}, saved = null, requests = 0
  const options = {
    currentVersion: '1.0.9',
    readCache: async () => saved,
    writeCache: async value => { saved = value },
    readPreferences: async () => preferences,
    writePreferences: async value => { preferences = value },
    fetchRelease: async () => { requests++; return { tag_name: 'v1.0.10' } },
  }
  const checker = createUpdateChecker(options)
  const disabled = await checker.setAutomaticCheckEnabled(false)
  assert.equal(disabled.automaticCheckEnabled, false)
  assert.equal(disabled.checkedAt, 0)
  assert.equal(requests, 0)
  const restarted = createUpdateChecker(options)
  assert.equal((await restarted.check()).automaticCheckEnabled, false)
  assert.equal(requests, 0)
  assert.equal((await restarted.check({ force: true })).updateAvailable, true)
  assert.equal(requests, 1)
  saved.checkedAt = 1
  assert.equal((await restarted.check()).source, 'cache')
  assert.equal(requests, 1)
  assert.equal((await restarted.setAutomaticCheckEnabled(true)).automaticCheckEnabled, true)
  assert.equal((await restarted.check()).source, 'network')
  assert.equal(requests, 2)
})

test('automatic check preference defaults to enabled', async () => {
  const checker = createUpdateChecker({
    currentVersion: '1.0.9', readCache: async () => null, writeCache: async () => {},
    fetchRelease: async () => ({ tag_name: 'v1.0.9' }),
  })
  assert.equal((await checker.check()).automaticCheckEnabled, true)
})


test('desktop service keeps the check preference across service instances', async () => {
  const fs = require('node:fs/promises')
  const os = require('node:os')
  const path = require('node:path')
  const { createDesktopUpdateService } = require('../src/desktop-update.cjs')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workstep-update-test-'))
  let requests = 0
  const app = { getPath: () => directory, getVersion: () => '1.0.9' }
  const fetchRelease = async () => { requests++; return { ok: true, json: async () => ({ tag_name: 'v1.0.10' }) } }
  try {
    await createDesktopUpdateService(app, fetchRelease).setAutomaticCheckEnabled(false)
    const restarted = createDesktopUpdateService(app, fetchRelease)
    assert.equal((await restarted.check()).automaticCheckEnabled, false)
    assert.equal(requests, 0)
    await restarted.check({ force: true })
    assert.equal(requests, 1)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
