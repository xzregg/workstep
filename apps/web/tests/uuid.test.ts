import assert from 'node:assert/strict'
import test from 'node:test'

import { randomUuid } from '../src/utils/uuid.ts'

test('randomUuid uses crypto.randomUUID when available', () => {
  const original = globalThis.crypto
  try {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { randomUUID: () => 'native-uuid' },
    })
    assert.equal(randomUuid(), 'native-uuid')
  } finally {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: original,
    })
  }
})

test('randomUuid falls back when randomUUID is missing (insecure context)', () => {
  const original = globalThis.crypto
  try {
    // Plain HTTP on a LAN address exposes crypto without randomUUID.
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {},
    })
    const id = randomUuid()
    assert.equal(typeof id, 'string')
    assert.ok(id.length > 0)
  } finally {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: original,
    })
  }
})

test('randomUuid stays unique when randomUUID is missing', () => {
  const original = globalThis.crypto
  try {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {},
    })
    const ids = new Set(Array.from({ length: 50 }, () => randomUuid()))
    assert.equal(ids.size, 50)
  } finally {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: original,
    })
  }
})
