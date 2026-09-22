import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const assistantPanelSource = await readFile(
  new URL('../src/components/AssistantChatPanel.tsx', import.meta.url),
  'utf8',
)
const styles = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

test('assistant chat header title stays on one line within 30% of the header', () => {
  assert.match(assistantPanelSource, /className="assistant-chat-header-title"/)
  assert.match(styles, /\.assistant-chat-header-title\s*\{[\s\S]*?max-width:\s*30%/)
  assert.match(styles, /\.assistant-chat-header-title\s*\{[\s\S]*?white-space:\s*nowrap/)
  assert.match(styles, /\.assistant-chat-header-title\s*\{[\s\S]*?overflow:\s*hidden/)
  assert.match(styles, /\.assistant-chat-header-title\s*\{[\s\S]*?text-overflow:\s*ellipsis/)
})
