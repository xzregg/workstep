import assert from 'node:assert/strict'
import test from 'node:test'

import { localDateTimeToIso, utcToLocalDateTime } from '../src/utils/scheduledStart.ts'

test('converts a local datetime input to an ISO instant and back', () => {
  const iso = localDateTimeToIso('2030-01-02T03:04')
  assert.ok(iso)
  assert.equal(utcToLocalDateTime(iso), '2030-01-02T03:04:00')
})

test('rejects an empty or invalid scheduled datetime', () => {
  assert.equal(localDateTimeToIso(''), null)
  assert.equal(localDateTimeToIso('not-a-date'), null)
})
