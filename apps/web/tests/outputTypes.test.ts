import assert from 'node:assert/strict'
import test from 'node:test'

import { OUTPUT_TYPES } from '../src/config/outputTypes.ts'

test('stage outputs offer a directory type for multi-file deliverables', () => {
  assert.ok(OUTPUT_TYPES.includes('directory'))
})
