import assert from 'node:assert/strict'
import test from 'node:test'

import { processTracePanelAvailableWidth } from '../src/utils/processTraceLayout.ts'

test('keeps the process trace popup away from the viewport right edge', () => {
  assert.equal(processTracePanelAvailableWidth(1200, 460), 716)
  assert.equal(processTracePanelAvailableWidth(900, 560), 316)
})

test('never returns a negative popup width', () => {
  assert.equal(processTracePanelAvailableWidth(320, 310), 0)
})
