import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveAccessExpiresAt } from '../src/utils/remoteDeviceAccess.ts'

const NOW_MS = 1_800_000_000_000

test('device access defaults to permanent and presets start from now', () => {
  assert.equal(resolveAccessExpiresAt('permanent', '', NOW_MS), null)
  assert.equal(resolveAccessExpiresAt('day', '', NOW_MS), 1_800_086_400)
  assert.equal(resolveAccessExpiresAt('week', '', NOW_MS), 1_800_604_800)
  assert.equal(resolveAccessExpiresAt('month', '', NOW_MS), 1_802_592_000)
})

test('custom device access requires a future date', () => {
  assert.equal(
    resolveAccessExpiresAt('custom', '2028-01-15T08:00', NOW_MS),
    Math.floor(new Date('2028-01-15T08:00').getTime() / 1000),
  )
  assert.throws(
    () => resolveAccessExpiresAt('custom', '', NOW_MS),
    /future/i,
  )
  assert.throws(
    () => resolveAccessExpiresAt('custom', '2020-01-01T00:00', NOW_MS),
    /future/i,
  )
})
