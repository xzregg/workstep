import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const bubbleSource = fs.readFileSync(new URL('../src/components/ChatMessageBubble.tsx', import.meta.url), 'utf8')
const taskDetailSource = fs.readFileSync(new URL('../src/components/TaskDetailView.tsx', import.meta.url), 'utf8')
const assistantSource = fs.readFileSync(new URL('../src/components/AssistantChatPanel.tsx', import.meta.url), 'utf8')

test('remote user avatars expose the sender name and device in the tooltip', () => {
  assert.match(bubbleSource, /senderTitle\?: string/)
  assert.match(bubbleSource, /title=\{senderTitle \|\| sender\}/)
  assert.match(taskDetailSource, /senderTitle=\{isUser && msg\.author_device_name/)
  assert.match(assistantSource, /senderTitle=\{message\.role === 'user' && message\.author_device_name/)
})
