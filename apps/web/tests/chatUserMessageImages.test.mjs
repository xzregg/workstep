import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const bubbleSource = await readFile(
  new URL('../src/components/ChatMessageBubble.tsx', import.meta.url),
  'utf8',
)

test('user messages render uploaded image Markdown with the shared renderer', () => {
  assert.match(bubbleSource, /import MarkdownMessage from '\.\/MarkdownMessage'/)
  assert.match(
    bubbleSource,
    /<MarkdownMessage[\s\S]*content=\{content\}[\s\S]*projectId=\{projectId\}[\s\S]*className="user-message-markdown"/,
  )
  assert.doesNotMatch(
    bubbleSource,
    /<div style=\{\{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' \}\}>\{content\}<\/div>/,
  )
})
