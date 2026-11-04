const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createHash } = require('node:crypto')
const { createFeedbackWindowController } = require('../src/feedback-window.cjs')

function fixture(failure) {
  let instance, cleared = 0
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super()
      instance = this
      this.options = options
      this.webContents = new EventEmitter()
      this.webContents.setWindowOpenHandler = () => {}
    }
    setMenu() {}
    async loadURL(url) {
      this.url = url
      if (failure) { const error = failure; failure = null; throw error }
    }
    async loadFile() { throw Error('file protocol is unavailable in the packaged app') }
    destroy() { this.destroyed = true; this.emit('closed') }
    isDestroyed() { return Boolean(this.destroyed) }
    isMinimized() { return false }
    show() {}
    focus() {}
  }
  const controller = createFeedbackWindowController({ BrowserWindow: FakeWindow, service: { clear() { cleared++ } } })
  return { controller, window: () => instance, cleared: () => cleared }
}

test('feedback loads a self-contained page without file protocol privileges', async () => {
  const f = fixture()
  await f.controller.open()
  const window = f.window()
  assert.match(window.url, /^data:text\/html;charset=UTF-8,/)
  const html = decodeURIComponent(window.url.slice(window.url.indexOf(',') + 1))
  assert.ok(!html.includes('href="feedback.css"'))
  assert.ok(!html.includes('src="feedback-renderer.js"'))
  for (const tag of ['style', 'script']) {
    const content = html.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]
    assert.ok(content, `${tag} is bundled`)
    const hash = createHash('sha256').update(content).digest('base64')
    assert.ok(html.includes(`'sha256-${hash}'`), `${tag} is authorized by its CSP hash`)
  }
  assert.ok(!html.includes('unsafe-inline'))
  assert.equal(window.options.webPreferences.sandbox, true)
  assert.equal(window.options.webPreferences.contextIsolation, true)
  assert.match(window.options.webPreferences.preload, /feedback-preload\.cjs$/)
  await f.controller.open()
  assert.equal(f.controller.getWindow(), window)
})

test('failed feedback loading destroys the window and permits retry', async () => {
  const error = Error('load failed')
  const f = fixture(error)
  await assert.rejects(f.controller.open(), error)
  assert.equal(f.window().isDestroyed(), true)
  assert.equal(f.controller.getWindow(), null)
  assert.equal(f.cleared(), 1)
  await f.controller.open()
  assert.equal(f.controller.getWindow().isDestroyed(), false)
})
