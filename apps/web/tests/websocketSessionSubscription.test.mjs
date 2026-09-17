import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(
  new URL('../src/hooks/useWebSocket.ts', import.meta.url),
  'utf8',
)

test('WebSocket subscribes to every session shown in the sidebar', () => {
  assert.match(source, /Object\.values\(useChatListStore\.getState\(\)\.sessionsByProject\)/)
})
