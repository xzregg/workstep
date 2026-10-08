const test = require('node:test')
const assert = require('node:assert/strict')
const { attachHideOnClose, createGracefulQuit } = require('../src/window-lifecycle.cjs')

test('window close hides while running and closes only during application quit', () => {
  let closeHandler, hidden = 0, prevented = 0, quitting = false
  const window = {
    on(event, handler) { if (event === 'close') closeHandler = handler },
    hide() { hidden++ },
  }
  attachHideOnClose(window, () => quitting)

  closeHandler({ preventDefault() { prevented++ } })
  assert.deepEqual({ hidden, prevented }, { hidden: 1, prevented: 1 })

  quitting = true
  closeHandler({ preventDefault() { prevented++ } })
  assert.deepEqual({ hidden, prevented }, { hidden: 1, prevented: 1 })
})

test('application quit is released even when backend shutdown fails', async () => {
  let quits = 0, failure = null
  const handleQuit = createGracefulQuit({
    stop: async () => { throw new Error('Podman stop timeout') },
    quit: () => { quits++ },
    onError: error => { failure = error },
  })

  handleQuit({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(failure.message, 'Podman stop timeout')
  assert.equal(quits, 1)
})

test('application quit stops the backend once and then allows the second quit event', async () => {
  let releaseStop, stops = 0, quits = 0, starts = 0, prevented = 0
  const stopPending = new Promise(resolve => { releaseStop = resolve })
  const handleQuit = createGracefulQuit({
    stop: async () => { stops++; await stopPending },
    quit: () => { quits++ },
    onStart: () => { starts++ },
  })
  const event = { preventDefault() { prevented++ } }

  handleQuit(event)
  handleQuit(event)
  assert.deepEqual({ stops, quits, starts, prevented }, { stops: 0, quits: 0, starts: 2, prevented: 2 })
  await Promise.resolve()
  assert.equal(stops, 1)
  releaseStop()
  await stopPending
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(quits, 1)

  handleQuit(event)
  assert.deepEqual({ starts, prevented }, { starts: 3, prevented: 2 })
})
