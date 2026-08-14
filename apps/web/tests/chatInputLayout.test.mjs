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

test('shared conversation history uses the same centered content width', () => {
  assert.match(assistantPanel, /className="chat-history-scroll"/)
  assert.match(taskDetail, /className="chat-history-scroll task-chat-history-scroll"/)
  assert.match(css, /\.chat-history-scroll\s*\{[^}]*calc\(\(100% - 800px\) \/ 2\)/s)
  assert.match(css, /\.task-chat-history-scroll\s*\{[^}]*calc\(\(100% - 800px\) \/ 2\)/s)
})

test('assistant quick prompts align with the centered chat input', () => {
  assert.match(assistantPanel, /className="chat-quick-prompts"/)
  assert.match(css, /\.chat-input-root,\s*\.chat-quick-prompts\s*\{[^}]*max-width:\s*800px/s)
  assert.match(css, /\.chat-input-root,\s*\.chat-quick-prompts\s*\{[^}]*margin-inline:\s*auto/s)
})

test('slash command menu uses a Codex-style full-width row layout', () => {
  assert.match(source, /className="chat-skill-menu-icon"/)
  assert.match(source, /className="chat-skill-menu-copy"/)
  assert.match(css, /\.chat-skill-menu\s*\{[^}]*right:\s*0[^}]*left:\s*0/s)
  assert.match(css, /\.chat-skill-menu-item\s*\{[^}]*grid-template-columns:\s*18px minmax\(0, auto\) minmax\(0, 1fr\)/s)
  assert.match(css, /\.chat-skill-menu-copy\s*\{[^}]*text-align:\s*right/s)
})
