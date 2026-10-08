const assert = require('node:assert/strict')
const test = require('node:test')
const { desktopWindowTitle } = require('../src/window-title.cjs')

test('packaged desktop title includes the application version', () => {
  assert.equal(desktopWindowTitle(true, '1.0.9'), 'WorkStep 1.0.9')
})

test('development desktop title stays concise', () => {
  assert.equal(desktopWindowTitle(false, '1.0.9'), 'WorkStep')
})
