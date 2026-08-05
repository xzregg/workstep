import assert from 'node:assert/strict'
import test from 'node:test'

import {
  durationMilliseconds,
  formatConversationDateTime,
  formatDuration,
  formatDurationBetween,
  toMilliseconds,
} from '../src/utils/datetime.ts'

test('formats recent conversation times by weekday and older times in full', () => {
  const now = new Date(2026, 7, 10, 12, 0, 0)

  assert.equal(
    formatConversationDateTime(new Date(2026, 7, 4, 11, 22, 33), now),
    '周二 11:22:33',
  )
  assert.equal(
    formatConversationDateTime(new Date(2026, 7, 2, 11, 11, 11), now),
    '2026-08-02 11:11:11',
  )
})

test('parses ISO datetime and legacy epoch values', () => {
  assert.equal(toMilliseconds('2024-08-03T00:00:00+00:00'), 1_722_643_200_000)
  assert.equal(toMilliseconds(1_722_643_200), 1_722_643_200_000)
  assert.equal(toMilliseconds(1_722_643_200_000), 1_722_643_200_000)
})

test('calculates precise datetime duration and rejects invalid ranges', () => {
  assert.equal(durationMilliseconds(
    '2024-08-03T00:00:00+00:00',
    '2024-08-03T01:02:03.500+00:00',
  ), 3_723_500)
  assert.equal(durationMilliseconds(
    '2024-08-03T01:00:00+00:00',
    '2024-08-03T00:00:00+00:00',
  ), null)
})

test('formats sub-second, long, and cross-day durations consistently', () => {
  assert.equal(formatDuration(0), '0秒')
  assert.equal(formatDuration(500), '<1秒')
  assert.equal(formatDuration(65_000), '1分5秒')
  assert.equal(formatDuration(3_723_500), '1小时2分')
  assert.equal(formatDuration(93_600_000), '1天2小时')
  assert.equal(formatDurationBetween(null, new Date()), null)
})
