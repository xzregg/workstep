const assert = require('node:assert/strict')
const test = require('node:test')
const { createPerformanceRecorder } = require('../../desktop/src/runtime-diagnostics.js')

function fixture(eventTiming = false) {
  let now = 100
  let frame
  let timeout
  const observers = []
  const sky = new EventTarget()
  const attributes = new Set()
  sky.setAttribute = name => attributes.add(name)
  sky.removeAttribute = name => attributes.delete(name)
  const document = Object.assign(new EventTarget(), {
    hidden: false, querySelector: () => sky, getElementsByTagName: () => ({ length: 42 }),
    scripts: [{ src: 'https://example.test/assets/index-build123.js' }],
  })
  class Observer {
    static supportedEntryTypes = eventTiming ? ['longtask', 'event', 'resource'] : ['longtask', 'resource']
    constructor(receive) { this.receive = receive; observers.push(this) }
    observe({ type }) { this.type = type }
    disconnect() { this.disconnected = true }
    takeRecords() { return [] }
  }
  const window = Object.assign(new EventTarget(), {
    Event, document, performance: { now: () => now, timeOrigin: 1_000_000 }, PerformanceObserver: Observer,
    requestAnimationFrame: callback => { frame = callback; return 1 },
    cancelAnimationFrame() { frame = null },
    setTimeout: callback => { timeout = callback; return 1 },
    clearTimeout() { timeout = null },
  })
  const recorder = createPerformanceRecorder(window)
  return { recorder, window, observers, document, sky, attributes, move: value => { now = value; frame(value) },
    expire: () => { now = 15100; timeout() }, frame: () => frame }
}

test('separates frame, long task, resource, atlas and message timing without copying page data', () => {
  const { recorder, observers, sky, move, attributes, expire } = fixture()
  assert.equal(recorder.start(), true)
  assert.equal(recorder.start(), false)
  assert.equal(attributes.has('data-atlas-sampling'), true)
  move(110)
  move(155)
  observers[0].receive({ getEntries: () => [{ startTime: 125, duration: 65 }] })
  observers[1].receive({ getEntries: () => [{ startTime: 140, duration: 900, name: 'https://test/private?token=secret' }] })
  sky.dispatchEvent(new CustomEvent('workstep:atlas-profile-frame', { detail: { particles: 8, markers: 4 } }))
  recorder.mark('markdown-queue', 120, 12)
  recorder.mark('markdown-parse', 132, 19)
  expire()
  const { recording, result } = recorder.snapshot()
  assert.equal(recording, false)
  assert.equal(result.reason, 'timeout')
  assert.equal(result.nodes, 42)
  assert.equal(result.build, 'index-build123.js')
  assert.deepEqual(result.events.map(event => event.type), [
    'frame', 'markdown-queue', 'longtask', 'markdown-parse', 'resource', 'atlas-particles', 'atlas-markers',
  ])
  assert.deepEqual(result.aggregates.resources, [1, 900, 900, 900])
  assert.doesNotMatch(JSON.stringify(result), /private|secret/)
  assert.equal(attributes.size, 0)
  assert.ok(observers.every(observer => observer.disconnected))
})

test('hiding the document stops sampling and preserves the report', () => {
  const { recorder, document, frame } = fixture()
  recorder.start()
  document.hidden = true
  document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(frame(), null)
  assert.equal(recorder.snapshot().result.reason, 'hidden')
  assert.equal(recorder.start(), false)
})

test('attributes delayed entries to the original page and records SPA navigation without identifiers', () => {
  const { recorder, window, observers, document, move, expire } = fixture(true)
  window.location = { pathname: '/workspace/secret-device/chat', search: '?session=secret-session' }
  recorder.start()
  const key = new Event('keydown')
  Object.defineProperty(key, 'target', { value: { closest: selector => selector.includes('.chat-input-editor') } })
  document.dispatchEvent(key)
  move(125)
  window.location.pathname = '/workspace/secret-device/companion'
  move(160)
  observers[0].receive({ getEntries: () => [{ startTime: 120, duration: 90 }] })
  observers[1].receive({ getEntries: () => [{ startTime: 119, duration: 80, interactionId: 1, name: 'keydown', target: key.target }] })
  expire()
  const { result } = recorder.snapshot()
  assert.deepEqual(result.pages, [{ at: 0, page: 'chat' }, { at: 60, page: 'companion' }])
  assert.deepEqual(result.events.find(event => event.type === 'longtask'), {
    type: 'longtask', at: 20, duration: 90, page: 'chat', feature: 'composer', action: 'typing',
  })
  assert.deepEqual(result.events.find(event => event.type === 'input'), {
    type: 'input', at: 19, duration: 80, page: 'chat', feature: 'composer', action: 'typing',
  })
  assert.doesNotMatch(JSON.stringify(result), /secret-device|secret-session/)
})
