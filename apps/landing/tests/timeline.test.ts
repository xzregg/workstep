import { describe, expect, it } from 'vitest'
import { clamp, formatTime, progressFor, stepTime } from '../src/demo/timeline'

describe('demo timeline utils', () => {
  it('clamps values to a range', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
  })

  it('wraps forward past the duration when looping', () => {
    expect(stepTime(9500, 1000, 10000, true)).toBe(500)
  })

  it('wraps backward below zero when looping', () => {
    expect(stepTime(500, -1000, 10000, true)).toBe(9500)
  })

  it('clamps at the end when not looping', () => {
    expect(stepTime(9900, 500, 10000, false)).toBe(10000)
    expect(stepTime(0, -100, 10000, false)).toBe(0)
  })

  it('formats milliseconds as m:ss', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(65400)).toBe('1:05')
    expect(formatTime(5999)).toBe('0:05')
  })

  it('computes normalized progress', () => {
    expect(progressFor(5000, 10000)).toBe(0.5)
    expect(progressFor(20000, 10000)).toBe(1)
  })
})
