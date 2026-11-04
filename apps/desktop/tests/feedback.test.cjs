const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { formatFeedback, createFeedbackService, registerFeedbackIpc, captureRendererErrors } = require('../src/feedback.cjs')

function fixture() {
  let captures = 0, failText = false
  const writes = [], source = { isDestroyed: () => false, webContents: {
    getURL: () => 'http://127.0.0.1:8766/chat',
    capturePage: async () => { captures++; return { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,cGlj' } },
  } }
  const service = createFeedbackService({
    diagnostics: { redact: value => value.replaceAll('secret', '[redacted]'),
      collectReport: async () => ({ generatedAt: '2026-11-04T00:00:00.000Z', metadata: { version: '1.0.17' }, logs: { 'desktop.log': 'error secret' }, warnings: [] }) },
    runtime: async () => ({ startedAt: '2026-11-03T23:00:00.000Z', uptimeSeconds: 3600, backendMode: '本地', backendState: '已退出' }),
    getWindow: () => source, rootUrl: () => 'http://127.0.0.1:8766',
    clipboard: { writeText: text => { if (failText) throw Error('clipboard busy'); writes.push(text) }, writeImage: image => writes.push(image) },
  })
  return { service, source, writes, captures: () => captures, failText: value => { failText = value } }
}

test('feedback text includes runtime and newest Unicode logs under a byte budget', () => {
  const report = { generatedAt: 'now', metadata: { version: 'v1', platform: 'darwin', arch: 'arm64', osRelease: '25', electron: '43' }, logs: { 'desktop.log': '错'.repeat(200000) + '\nlatest error' }, warnings: ['sandbox unavailable'] }
  const text = formatFeedback(report, { startedAt: 'start', uptimeSeconds: 3661, backendState: '已退出' })
  assert.ok(Buffer.byteLength(text) <= 256 * 1024)
  for (const value of ['v1', 'darwin', 'arm64', '43', 'start', '1小时1分1秒', '已退出', 'latest error', '已截断', 'sandbox unavailable', '复现步骤']) assert.ok(text.includes(value), value)
  assert.ok(!text.includes('\uFFFD'))
})

test('text copy precedes explicit screenshot consent; retry and cancel preserve text', async () => {
  const f = fixture()
  await assert.rejects(f.service.capture(), /先复制/)
  f.failText(true)
  await assert.rejects(f.service.copyText(), /clipboard busy/)
  assert.equal(f.captures(), 0)
  f.failText(false)
  await f.service.copyText()
  assert.match(f.writes[0], /\[redacted\]/)
  assert.equal(f.captures(), 0)
  await assert.rejects(f.service.copyImage(), /截图/)
  assert.equal(await f.service.capture(), 'data:image/png;base64,cGlj')
  assert.equal(f.writes.length, 1, 'preview does not modify clipboard')
  await f.service.copyImage()
  f.service.clear()
  await assert.rejects(f.service.copyImage(), /截图/)
  await assert.rejects(f.service.capture(), /先复制/)
})

test('screenshot failure does not invalidate copied text; untrusted pages cannot be captured', async () => {
  const f = fixture()
  await f.service.copyText()
  f.source.webContents.getURL = () => 'https://example.org/login'
  await assert.rejects(f.service.capture(), /WorkStep/)
  assert.equal(f.captures(), 0)
  assert.equal(f.writes.length, 1)
})

test('empty captures and page changes fail without overwriting the copied report', async () => {
  const f = fixture()
  await f.service.copyText()
  const copied = f.writes[0]
  f.source.webContents.capturePage = async () => ({ isEmpty: () => true })
  await assert.rejects(f.service.capture(), /截图为空/)
  await assert.rejects(f.service.copyImage(), /截图/)
  f.source.webContents.capturePage = async () => {
    f.source.webContents.getURL = () => 'https://example.org/login'
    return { isEmpty: () => false }
  }
  await assert.rejects(f.service.capture(), /页面已切换/)
  assert.deepEqual(f.writes, [copied])
})

test('overlapping collection shares one operation and clear invalidates pending capture', async () => {
  const f = fixture()
  await Promise.all([f.service.copyText(), f.service.copyText()])
  assert.equal(f.writes.length, 1)
  let resolve
  f.source.webContents.capturePage = () => new Promise(done => { resolve = done })
  const pending = f.service.capture()
  f.service.clear()
  resolve({ isEmpty: () => false, toDataURL: () => 'image' })
  await assert.rejects(pending, /关闭/)
  await assert.rejects(f.service.copyImage(), /截图/)
})

test('feedback IPC rejects foreign windows and subframes', async () => {
  const handlers = new Map(), f = fixture()
  const preview = { isDestroyed: () => false, webContents: { mainFrame: {} } }
  f.source.webContents.mainFrame = {}
  let opened = 0
  registerFeedbackIpc({ ipcMain: { removeHandler() {}, handle: (key, fn) => handlers.set(key, fn) },
    getWindow: () => f.source, getFeedbackWindow: () => preview, rootUrl: () => 'http://127.0.0.1:8766', service: f.service, open: async () => { opened++ } })
  const start = handlers.get('workstep:feedback:open')
  await assert.rejects(start({ sender: {}, senderFrame: { url: 'http://127.0.0.1:8766' } }), /来源/)
  await assert.rejects(start({ sender: f.source.webContents, senderFrame: { url: 'http://127.0.0.1:8766' } }), /来源/)
  f.source.webContents.mainFrame.url = 'http://127.0.0.1:8766/chat'
  await start({ sender: f.source.webContents, senderFrame: f.source.webContents.mainFrame })
  assert.equal(opened, 1)
  const action = handlers.get('workstep:feedback:action')
  await assert.rejects(action({ sender: f.source.webContents }, 'capture'), /来源/)
  await assert.rejects(action({ sender: preview.webContents, senderFrame: preview.webContents.mainFrame }, 'arbitrary'), /操作/)
})

test('renderer errors are bounded, deduplicated and restricted to the workspace', () => {
  const contents = new EventEmitter(), records = []
  contents.getURL = () => 'http://127.0.0.1:8766/chat'
  captureRendererErrors(contents, { write: (...args) => records.push(args) }, () => 'http://127.0.0.1:8766')
  captureRendererErrors(contents, { write: (...args) => records.push(args) }, () => 'http://127.0.0.1:8766')
  contents.emit('console-message', { level: 'error', message: 'uncaught failure' })
  contents.emit('console-message', { level: 'error', message: 'uncaught failure' })
  contents.emit('console-message', { level: 'info', message: 'chat text' })
  contents.getURL = () => 'https://example.org/login'
  contents.emit('console-message', { level: 'error', message: 'private login' })
  assert.equal(records.length, 1)
  assert.match(records[0][2], /uncaught failure/)
})
