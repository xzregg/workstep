const test = require('node:test')
const assert = require('node:assert/strict')
const { attachHideOnClose } = require('../src/window-lifecycle.cjs')

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
