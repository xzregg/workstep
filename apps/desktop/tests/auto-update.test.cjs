const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createAutoUpdateController } = require('../src/auto-update.cjs')

test('only an explicit request downloads, concurrent clicks share work, stop precedes install', async () => {
  const updater = new EventEmitter(), calls = []
  let finish
  updater.checkForUpdates = async () => { calls.push('check'); return { updateInfo: { version: '2.0.0' } } }
  updater.downloadUpdate = () => { calls.push('download'); return new Promise(resolve => { finish = resolve }) }
  updater.quitAndInstall = (...args) => calls.push(['install', ...args])
  const controller = createAutoUpdateController({ updater, currentVersion: '1.0.0',
    beforeInstall: async () => calls.push('stop') })
  assert.equal(updater.autoDownload, false)
  assert.equal(updater.autoInstallOnAppQuit, false)
  assert.deepEqual(calls, [])
  const first = controller.start(), second = controller.start()
  await new Promise(setImmediate)
  updater.emit('download-progress', { percent: 42.7 })
  assert.deepEqual(controller.status(), { phase: 'downloading', percent: 43, error: null })
  finish()
  await Promise.all([first, second])
  assert.deepEqual(calls, ['check', 'download', 'stop', ['install', true, true]])
  assert.equal(controller.status().phase, 'installing')
})

test('no newer version never downloads; errors remain visible and allow retry', async () => {
  const updater = new EventEmitter()
  updater.checkForUpdates = async () => ({ updateInfo: { version: '1.0.0' } })
  updater.downloadUpdate = () => assert.fail('no download')
  const controller = createAutoUpdateController({ updater, currentVersion: '1.0.0', beforeInstall: async () => {} })
  await controller.start()
  assert.equal(controller.status().phase, 'idle')
  updater.checkForUpdates = async () => { throw new Error('network failed') }
  await assert.rejects(controller.start(), /network failed/)
  assert.equal(controller.status().phase, 'error')
  assert.match(controller.status().error, /network failed/)
  updater.checkForUpdates = async () => ({ updateInfo: { version: '1.0.0' } })
  await controller.start()
  assert.equal(controller.status().error, null)
})

test('failed backend shutdown prevents installation', async () => {
  const updater = new EventEmitter()
  updater.checkForUpdates = async () => ({ updateInfo: { version: '2.0.0' } })
  updater.downloadUpdate = async () => {}
  updater.quitAndInstall = () => assert.fail('must not install')
  const controller = createAutoUpdateController({ updater, currentVersion: '1.0.0',
    beforeInstall: async () => { throw new Error('stop failed') } })
  await assert.rejects(controller.start(), /stop failed/)
  assert.equal(controller.status().phase, 'error')
})
