import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/ChatInput.tsx', import.meta.url), 'utf8')
const assistantPanel = await readFile(new URL('../src/components/AssistantChatPanel.tsx', import.meta.url), 'utf8')
const taskDetail = await readFile(new URL('../src/components/TaskDetailView.tsx', import.meta.url), 'utf8')
const chatPage = await readFile(new URL('../src/pages/ChatPage.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

test('shared chat input stays centered and leaves room on wide conversations', () => {
  assert.match(source, /className="chat-input-root"/)
  assert.match(css, /\.chat-input-root,\s*\.chat-quick-prompts\s*\{[^}]*width:\s*100%/s)
})

test('chat input renders optional account quota separately from context usage', () => {
  assert.match(source, /quota\?: ChatEngineQuota \| null/)
  assert.match(source, /className="[^"]*chat-input-quota[^"]*"/)
  assert.match(source, /quota\.primary\.remaining_percent/)
  assert.match(source, /className="chat-input-context-tip chat-input-quota-tip"/)
  assert.match(source, /quota\.secondary/)
  assert.match(source, /quota\.individual_limit/)
})

test('context usage is a circular progress indicator without visible percent text', () => {
  assert.match(source, /className="chat-input-context-ring"/)
  assert.match(source, /strokeDasharray=\{`\$\{Math\.min\(100, Math\.max\(0, context\.percent\)\)\} 100`\}/)
  assert.doesNotMatch(source, /\{Math\.round\(context\.percent\)\}%\s*<span className="chat-input-context-tip/)
})

test('quota is rendered to the left of context usage', () => {
  assert.ok(source.indexOf('{quota?.primary && (') < source.indexOf('{context && ('))
})

test('chat input toolbar wraps controls instead of overflowing narrow composers', () => {
  assert.match(source, /className="chat-input-toolbar"/)
  assert.match(css, /\.chat-input-toolbar\s*\{[^}]*flex-wrap:\s*wrap/s)
})

test('session chat requests quota on entry and after an engine run finishes', () => {
  assert.match(chatPage, /engineApi\.quota/)
  assert.match(chatPage, /if \(running \|\| !activeProject\?\.id\) return/)
  assert.match(chatPage, /\[running, effectiveEngine, activeProject\?\.id\]/)
})
