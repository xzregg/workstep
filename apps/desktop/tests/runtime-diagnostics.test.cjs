const test = require("node:test")
const assert = require("node:assert/strict")
const { normalizeLogs, filterLogs, buildReport } = require("../src/runtime-diagnostics.js")

test("normalizes rotated multiline logs and filters the selected recording window", () => {
  const logs = normalizeLogs([
    { source: "daemon", text: "2026-11-23T00:00:01Z ERROR failed\nTraceback\n2026-11-23T00:00:04Z INFO ready" },
    { source: "desktop", text: "2026-11-23T00:00:02Z warn timeout" },
  ])
  assert.equal(logs.length, 3)
  assert.equal(logs[0].summary, "ready")
  assert.match(logs[2].detail, /Traceback/)
  assert.equal(filterLogs(logs, { level: "warn", query: "timeout", from: Date.parse("2026-11-23T00:00:02Z") }).length, 1)
})

test("export omits raw text, arbitrary metadata and unrecognized event fields", () => {
  const logs = normalizeLogs([{ source: "daemon", text: "2026-11-23T00:00:01Z ERROR Bearer secret and private message" }])
  const text = buildReport({ platform: "android", version: "1.0.61", password: "secret" },
    { startedAt: 1, duration: 100, pages: [{ at: 0, page: 'chat', path: '/workspace/secret' }, { at: 10, page: 'secret' }],
      events: [{ type: 'longtask', at: 5, duration: 90, body: 'private message', page: 'chat', feature: 'composer', action: 'secret' }] }, logs)
  assert.doesNotMatch(text, /secret|private message|password/)
  const { recording } = JSON.parse(text)
  assert.deepEqual(recording.pages, [{ at: 0, page: 'chat' }])
  assert.deepEqual(recording.events[0], { type: 'longtask', at: 5, duration: 90, page: 'chat', feature: 'composer' })
})

test('rejects requests from non-diagnostic windows and their child frames', async () => {
  const { EventEmitter } = require('node:events')
  const { createRuntimeDiagnosticsWindow } = require('../src/runtime-diagnostics-window.cjs')
  let handler
  let current
  const copies = []
  class Window extends EventEmitter {
    constructor() {
      super()
      current = this
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: {}, setWindowOpenHandler() {},
      })
    }
    setMenu() {}
    async loadURL(url) { this.webContents.mainFrame.url = url }
  }
  const controller = createRuntimeDiagnosticsWindow({
    BrowserWindow: Window, ipcMain: { handle: (_channel, invoke) => { handler = invoke } },
    clipboard: { writeText: text => copies.push(text) }, getMainWindow: () => null,
  })
  await assert.rejects(handler({}, 'copy', 'one'), /Untrusted/)
  await controller.open()
  const trusted = current.webContents.mainFrame
  await assert.rejects(handler({ sender: {}, senderFrame: trusted }, 'copy', 'two'), /Untrusted/)
  await assert.rejects(handler({ sender: current.webContents, senderFrame: { url: trusted.url } }, 'copy', 'three'), /Untrusted/)
  assert.equal(await handler({ sender: current.webContents, senderFrame: trusted }, 'copy', 'safe'), true)
  assert.deepEqual(copies, ['safe'])
})

test('marks a capped log export as truncated', () => {
  const text = Array.from({ length: 650 }, (_, index) => `2026-11-23T00:00:01Z INFO event ${index}`).join('\n')
  const logs = normalizeLogs([{ source: 'daemon', text }])
  const output = buildReport({ platform: 'desktop' }, null, logs)
  const report = JSON.parse(output)
  assert.equal(report.logs.length, 600)
  assert.equal(report.truncated, true)
  assert.ok(Buffer.byteLength(output) <= 2 * 1024 * 1024)
})

test('copied reports preserve the slow request endpoint and timing', () => {
  const logs = [{ at: 1, source: 'request', level: 'warn',
    summary: '慢请求 GET /engine/execution/config HTTP 200 3302ms' }]
  assert.equal(JSON.parse(buildReport({}, null, logs)).logs[0].summary, logs[0].summary)
})
