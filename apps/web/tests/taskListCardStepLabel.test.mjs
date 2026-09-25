import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/TaskBoardCard.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

test('does not show the lane step name inside task cards', () => {
  assert.doesNotMatch(
    source,
    /background: `color-mix\(in oklab, \$\{lane\.color\}, transparent 90%\)`/,
  )
})

test('limits task card descriptions to a short preview', () => {
  assert.match(source, /className="task-board-card-description"/)
  assert.match(css, /\.task-board-card-description\s*\{[^}]*-webkit-line-clamp:\s*2/s)
  assert.match(css, /\.task-board-card-description\s*\{[^}]*overflow:\s*hidden/s)
})
