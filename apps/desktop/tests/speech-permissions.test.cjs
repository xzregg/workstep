const { test } = require('node:test')
const assert = require('node:assert/strict')
const { audioRequestAllowed, configureSpeechPermissions } = require('../src/speech-permissions.cjs')
const root = 'http://127.0.0.1:8766'
const contents = { getURL: () => root+'/chat', isDestroyed: () => false }
const details = { requestingUrl: root+'/chat', isMainFrame: true, mediaTypes: ['audio'] }
test('only trusted top-level audio capture receives permission', () => {
  assert.equal(audioRequestAllowed(contents, 'media', details, root), true)
  for (const change of [{ mediaTypes: ['video'] }, { mediaTypes: ['audio','video'] },
    { requestingUrl: 'https://example.com' }, { isMainFrame: false }, { mediaTypes: [] }]) {
    assert.equal(audioRequestAllowed(contents, 'media', { ...details, ...change }, root), false)
  }
  assert.equal(audioRequestAllowed(contents, 'notifications', details, root), false)
  assert.equal(audioRequestAllowed({ ...contents, getURL: () => 'https://example.com' }, 'media', details, root), false)
})

function handlers(preferences, platform = 'darwin') {
  const result = {}
  configureSpeechPermissions({
    setPermissionRequestHandler: handler => { result.request = handler },
    setPermissionCheckHandler: handler => { result.check = handler },
  }, root, { systemPreferences: preferences, platform })
  return result
}

test('macOS requests system microphone consent only after validating the page', async () => {
  let asks = 0
  const h = handlers({ getMediaAccessStatus: () => 'not-determined', askForMediaAccess: async type => { asks++; assert.equal(type, 'microphone'); return true } })
  assert.equal(h.check(contents, 'media', root, { mediaType: 'audio', isMainFrame: true }), false)
  let granted
  await h.request(contents, 'media', value => { granted = value }, details)
  assert.equal(granted, true)
  assert.equal(asks, 1)
  await h.request(contents, 'media', value => { granted = value }, { ...details, requestingUrl: 'https://other.test' })
  assert.equal(granted, false)
  assert.equal(asks, 1)
})

for (const state of ['denied', 'restricted']) {
  test(`system ${state} microphone access is never granted to the renderer`, async () => {
    let asks = 0
    const h = handlers({ getMediaAccessStatus: () => state, askForMediaAccess: async () => { asks++; return true } })
    let granted
    await h.request(contents, 'media', value => { granted = value }, details)
    assert.equal(granted, false)
    assert.equal(asks, 0)
    assert.equal(h.check(contents, 'media', root, { mediaType: 'audio', isMainFrame: true }), false)
  })
}

test('navigation during the macOS prompt invalidates the pending grant', async () => {
  let current = root+'/chat'
  const view = { ...contents, getURL: () => current }
  const h = handlers({ getMediaAccessStatus: () => 'not-determined', askForMediaAccess: async () => { current = 'https://other.test'; return true } })
  let granted
  await h.request(view, 'media', value => { granted = value }, details)
  assert.equal(granted, false)
})

test('Windows checks system settings without using the macOS consent API', async () => {
  const h = handlers({ getMediaAccessStatus: () => 'granted', askForMediaAccess: () => { throw new Error('macOS only') } }, 'win32')
  let granted
  await h.request(contents, 'media', value => { granted = value }, details)
  assert.equal(granted, true)
  assert.equal(h.check(contents, 'media', root, { mediaType: 'video', isMainFrame: true }), false)
})
