import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/ChatInput.tsx', import.meta.url), 'utf8')
const assistantPanel = await readFile(new URL('../src/components/AssistantChatPanel.tsx', import.meta.url), 'utf8')
const taskDetail = await readFile(new URL('../src/components/TaskDetailView.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

test('shared chat input stays centered and leaves room on wide conversations', () => {
  assert.match(source, /className="chat-input-root"/)
  assert.match(css, /\.chat-input-root,\s*\.chat-quick-prompts\s*\{[^}]*width:\s*100%/s)
})
