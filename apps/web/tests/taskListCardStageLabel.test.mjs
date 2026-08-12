import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/pages/TaskList.tsx', import.meta.url), 'utf8')

test('does not show the lane stage name inside task cards', () => {
  assert.doesNotMatch(
    source,
    /background: `color-mix\(in oklab, \$\{lane\.color\}, transparent 90%\)`/,
  )
})

test('limits task card descriptions to a short preview', () => {
  assert.match(source, /WebkitLineClamp: 2/)
  assert.match(source, /WebkitBoxOrient: 'vertical'/)
  assert.match(source, /overflow: 'hidden'/)
})

test('uses the stage lane color for the card left border', () => {
  assert.match(source, /borderLeft: `3px solid \$\{lane\.color\}`/)
})
