const test = require('node:test')
const assert = require('node:assert/strict')

const { createSandboxStartupWindow, startupViewState, formatSandboxFailure, applyPendingImageSwitch } = require('../src/sandbox-startup-window.cjs')

test('pending startup image is prepared and sandbox mode is restored automatically', async () => {
  const calls = []
  const image = 'sha256:' + 'a'.repeat(64)
  const manager = {
    settings: async () => ({ root: '/sandbox', project: '/project', mounts: [], pendingDockerImage: image, registeredProjects: ['/project'] }),
    prepareImage: async input => calls.push(['image', input]),
    prepare: async input => calls.push(['prepare', input]),
    setEnabled: async enabled => calls.push(['enabled', enabled]),
  }
  assert.equal(await applyPendingImageSwitch(manager), true)
  assert.deepEqual(calls, [
    ['image', { root: '/sandbox', dockerImage: image }],
    ['prepare', { root: '/sandbox', project: '/project', mounts: [], dockerImage: image }],
    ['enabled', true],
  ])
})

test('pending image switch follows its Docker tag when the scanned ID was replaced', async () => {
  const oldImage = 'sha256:' + 'a'.repeat(64)
  const newImage = 'sha256:' + 'b'.repeat(64)
  const calls = []
  const manager = {
    settings: async () => ({ root: '/sandbox', project: '/project', mounts: [], pendingDockerImage: oldImage, pendingDockerImageTag: 'workstep:latest' }),
    prepareImage: async input => {
      calls.push(['image', input.dockerImage])
      if (input.dockerImage === oldImage) throw new Error(`No such image: ${oldImage}`)
    },
    dockerImages: async () => ({ images: [{ id: newImage, tags: ['workstep:latest'], size: 1 }], error: null }),
    prepare: async input => calls.push(['prepare', input.dockerImage]),
    setEnabled: async enabled => calls.push(['enabled', enabled]),
  }

  assert.equal(await applyPendingImageSwitch(manager), true)
  assert.deepEqual(calls, [
    ['image', oldImage], ['image', newImage], ['prepare', newImage], ['enabled', true],
  ])
})

test('sandbox startup view exposes useful progress and failure details', () => {
  assert.deepEqual(startupViewState({ phase: 'starting', progress: null }), {
    phase: 'starting', label: '正在启动 WorkStep 容器', progress: 70, error: null,
  })
  assert.deepEqual(startupViewState({ phase: 'download', progress: { received: 25, total: 100 } }), {
    phase: 'download', label: '正在下载沙箱运行环境', progress: 9, error: null,
  })
  assert.deepEqual(startupViewState({ phase: 'error', error: 'health timeout' }), {
    phase: 'error', label: '沙箱启动失败', progress: null, error: 'health timeout',
  })
  assert.match(formatSandboxFailure(new Error('health timeout'), {
    phase: 'error', hostPort: 8766, logDirectory: '/sandbox/desktop',
  }), /当前阶段：沙箱启动失败[\s\S]*后台端口：8766[\s\S]*日志目录：\/sandbox\/desktop/)
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
  assert.match(decodeURIComponent(loadedUrl.split(',')[1]), /正在启动沙箱/)
  assert.match(decodeURIComponent(loadedUrl.split(',')[1]), /更换镜像/)
  assert.match(decodeURIComponent(loadedUrl.split(',')[1]), /复制日志/)
  assert.match(decodeURIComponent(loadedUrl.split(',')[1]), /\.startup-actions \{ display: flex/)
  assert.match(decodeURIComponent(loadedUrl.split(',')[1]), /overflow-y: auto/)
  assert.ok(options.height >= 680)
  assert.match(options.webPreferences.preload, /sandbox-startup-preload\.cjs$/)
  const preload = require('node:fs').readFileSync(options.webPreferences.preload, 'utf8')
  assert.match(preload, /正在切换…/)
  assert.match(preload, /invoke\('dockerImages'\)/)
  assert.match(preload, /startup:switchImage/)
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
