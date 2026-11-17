import assert from 'node:assert/strict'
import test from 'node:test'
import { extractA2uiMessages, normalizeA2uiMessages } from '../src/utils/a2ui.ts'

const envelope = (value: unknown) => ({
  version: 'v0.9.1', updateDataModel: { surfaceId: 'main', path: '/', value },
}) as Parameters<typeof normalizeA2uiMessages>[0][number]

test('ordinary A2UI data is preserved with and without a project', () => {
  const messages = [envelope({ choices: ['yes', 'no'], details: { enabled: true } })]
  assert.deepEqual(normalizeA2uiMessages(messages), messages)
  assert.deepEqual(normalizeA2uiMessages(messages, 'project'), messages)
})

test('oversized schema arrays are rejected before A2UI validation', () => {
  for (const project of [undefined, 'project']) {
    assert.deepEqual(normalizeA2uiMessages([envelope(Array(513).fill(null))], project), [])
  }
})

test('nested collections cannot bypass the aggregate node budget', () => {
  const value = Array.from({ length: 64 }, () => Array(256).fill(false))
  assert.deepEqual(normalizeA2uiMessages([envelope(value)]), [])
})

test('deep, cyclic, wide and oversized string inputs are rejected', () => {
  let deep: unknown = 'leaf'
  for (let index = 0; index < 40; index++) deep = { child: deep }
  const cycle: Record<string, unknown> = {}
  cycle.child = cycle
  const wide = Object.fromEntries(Array.from({ length: 513 }, (_, index) => ['field' + index, index]))
  for (const value of [deep, cycle, wide, 'x'.repeat(1_048_577)]) {
    assert.deepEqual(normalizeA2uiMessages([envelope(value)]), [])
  }
  assert.deepEqual(normalizeA2uiMessages(Array.from({ length: 257 }, () => envelope(null))), [])
})

test('aggregate string budget includes object keys and sibling values', () => {
  const value = { ['k'.repeat(600_000)]: 'v'.repeat(600_000) }
  assert.deepEqual(normalizeA2uiMessages([envelope(value)]), [])
})

test('oversized fence collections are refused and a later ordinary fence still works', () => {
  const oversized = JSON.stringify(envelope(Array(513).fill(null)))
  const ordinary = JSON.stringify(envelope({ ready: true }))
  const content = '```a2ui\n' + oversized + '\n```\n\n```a2ui\n' + ordinary + '\n```'
  assert.deepEqual(extractA2uiMessages(content), [JSON.parse(ordinary)])
})

test('fence text and total message count are bounded before catalog validation', () => {
  const ordinary = JSON.stringify(envelope({ ready: true }))
  assert.deepEqual(extractA2uiMessages('```a2ui\n' + ' '.repeat(1_048_577) + '\n```'), [])
  assert.deepEqual(extractA2uiMessages('```a2ui\n' + Array(257).fill(ordinary).join('\n') + '\n```'), [])
})

test('pretty-printed data parses once and ignores braces inside escaped strings', () => {
  const data = envelope({ text: 'quoted "}\\" [ braces', rows: Array(512).fill('ok') })
  const original = JSON.parse
  let calls = 0
  JSON.parse = (...args: Parameters<typeof JSON.parse>) => { calls++; return original(...args) }
  try {
    assert.deepEqual(extractA2uiMessages('```a2ui\n' + JSON.stringify(data, null, 2) + '\n```'), [data])
    assert.equal(calls, 1)
  } finally {
    JSON.parse = original
  }
})
