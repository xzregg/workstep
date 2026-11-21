const test = require('node:test')
const assert = require('node:assert/strict')

const { createSandboxStartupWindow, startupViewState, formatSandboxFailure, applyPendingImageSwitch } = require('../src/sandbox-startup-window.cjs')

test('an enabled sandbox can apply its queued image during startup', async () => {
  let enabled = true
  const manager = {
    settings: async () => ({ enabled, root: '/sandbox', pendingDockerImage: 'sha256:' + 'a'.repeat(64) }),
    setEnabled: async value => { enabled = value },
    prepare: async input => {
      assert.equal(enabled, false, 'image preparation requires sandbox disabled')
      assert.equal(input.keepMachineRunning, true)
    },
  }
  assert.equal(await applyPendingImageSwitch(manager), true)
  assert.equal(enabled, true)
})

test('pending startup image is prepared and sandbox mode is restored automatically', async () => {
  const calls = []
  const image = 'sha256:' + 'a'.repeat(64)
  const manager = {
    settings: async () => ({ root: '/sandbox', project: '/project', mounts: [], pendingDockerImage: image, registeredProjects: ['/project'] }),
    prepare: async input => calls.push(['prepare', input]),
    setEnabled: async enabled => calls.push(['enabled', enabled]),
  }
  assert.equal(await applyPendingImageSwitch(manager), true)
  assert.deepEqual(calls, [
    ['prepare', { root: '/sandbox', project: '/project', mounts: [], dockerImage: image, keepMachineRunning: true }],
    ['enabled', true],
  ])
})

test('pending image switch follows its updated Docker tag even when the old image is cached', async () => {
  const oldImage = 'sha256:' + 'a'.repeat(64)
  const newImage = 'sha256:' + 'b'.repeat(64)
  const calls = []
  const manager = {
    settings: async () => ({ root: '/sandbox', project: '/project', mounts: [], pendingDockerImage: oldImage, pendingDockerImageTag: 'workstep:latest' }),
    dockerImages: async () => ({ images: [{ id: newImage, tags: ['workstep:latest'], size: 1 }], error: null }),
    prepare: async input => calls.push(['prepare', input.dockerImage]),
    setEnabled: async enabled => calls.push(['enabled', enabled]),
  }

  assert.equal(await applyPendingImageSwitch(manager), true)
  assert.deepEqual(calls, [
    ['prepare', newImage], ['enabled', true],
  ])
})

test('failed fast image switch restores enabled mode and leaves the pending request recoverable', async () => {
  const image = 'sha256:' + 'c'.repeat(64)
  const calls = []
  let enabled = true
  const manager = {
    settings: async () => ({ enabled, root: '/sandbox', project: '/project', mounts: [], pendingDockerImage: image }),
    setEnabled: async value => { enabled = value; calls.push(['enabled', value]) },
    prepare: async () => { throw new Error('import interrupted') },
  }
  await assert.rejects(applyPendingImageSwitch(manager), /import interrupted/)
  assert.equal(enabled, true)
  assert.deepEqual(calls, [['enabled', false], ['enabled', true]])
})

test('sandbox startup view exposes useful progress and failure details', () => {
  assert.deepEqual(startupViewState({ phase: 'starting', progress: null }), {
    phase: 'starting', label: '正在启动 WorkStep 容器', progress: 70, error: null,
  })
  assert.deepEqual(startupViewState({ phase: 'download', progress: { received: 25, total: 100 } }), {
    phase: 'download', label: '正在下载沙箱运行环境', progress: 9, error: null,
  })
  assert.deepEqual(startupViewState({ phase: 'switching', message: '正在切换到 workstep:latest' }), {
    phase: 'switching', label: '正在切换到 workstep:latest', progress: 10, error: null,
  })
  assert.deepEqual(startupViewState({ phase: 'error', error: 'health timeout' }), {
    phase: 'error', label: 'Sandbox startup failed', progress: null, error: 'health timeout',
  })
  assert.match(formatSandboxFailure(new Error('health timeout'), {
    phase: 'error', hostPort: 8766, logDirectory: '/sandbox/desktop',
  }), /Stage: error[\s\S]*Backend port: 8766[\s\S]*Log directory: \/sandbox\/desktop/)
})

test('sandbox startup window loads packaged markup through a data URL', () => {
  let options, loadedUrl
  class FakeWindow {
    constructor(value) { options = value; this.webContents = { once() {}, send() {} } }
    on() {}
    once() {}
    isDestroyed() { return false }
    loadURL(value) { loadedUrl = value; return Promise.resolve() }
    close() {}
  }
  createSandboxStartupWindow(FakeWindow)
  assert.match(loadedUrl, /^data:text\/html;charset=UTF-8,/)
  const markup = decodeURIComponent(loadedUrl.split(',')[1])
  for (const label of ['启动步骤', '更换镜像', '复制日志', '查看日志', '返回启动进度']) {
    assert.ok(markup.includes(label), label)
  }
  assert.doesNotMatch(markup, /overflow(?:-y)?:\s*(auto|scroll)/)
  assert.equal(options.height, 680)
  assert.equal(options.minHeight, 520)
  assert.equal(options.webPreferences.contextIsolation, true)
  assert.equal(options.webPreferences.sandbox, true)
})

test('closing the sandbox startup window distinguishes user hide from internal close', () => {
  let closeHandler, exits = 0
  class FakeWindow {
    constructor() { this.webContents = { once() {}, send() {} } }
    on(event, handler) { if (event === 'close') closeHandler = handler }
    once() {}
    isDestroyed() { return false }
    loadURL() { return Promise.resolve() }
    close() { closeHandler() }
  }

  const startup = createSandboxStartupWindow(FakeWindow, { onUserClose: () => { exits += 1 } })
  closeHandler({ preventDefault() {} })
  assert.equal(exits, 1)

  startup.close()
  assert.equal(exits, 1)
})


test('startup keeps the failing step and provides one-shot recovery in the same window', async () => {
  let load, view
  class FakeWindow {
    constructor() {
      this.webContents = { once: (_event, callback) => { load = callback }, send: (_channel, state) => { view = state } }
    }
    on() {}
    once() {}
    isDestroyed() { return false }
    loadURL() { return Promise.resolve() }
  }
  const startup = createSandboxStartupWindow(FakeWindow, { image: { id: 'sha256:local', label: 'workstep:stable' } })
  load()
  assert.equal(view.step, 'config')
  assert.equal(view.image.label, 'workstep:stable')
  startup.update({ phase: 'machine' })
  startup.update({ phase: 'error', error: 'VM timed out' })
  assert.equal(view.step, 'machine')
  assert.equal(view.error, 'VM timed out')
  assert.equal(startup.recover('retry'), false)

  const response = startup.waitForRecovery({ phase: 'error', error: 'VM timed out' })
  assert.equal(view.recovery, true)
  assert.equal(startup.recover('invalid'), false)
  assert.equal(startup.recover('retry'), true)
  assert.equal(startup.recover('quit'), false)
  assert.equal(await response, 'retry')
  assert.equal(view.recovery, false)

  startup.update({ phase: 'starting' })
  assert.equal(view.step, 'container')
  startup.update({ phase: 'running' })
  assert.equal(view.phase, 'running')
})
