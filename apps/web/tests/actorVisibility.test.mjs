import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const taskListSource = await readFile(new URL('../src/pages/TaskList.tsx', import.meta.url), 'utf8')
const taskDetailSource = await readFile(new URL('../src/components/TaskConversationMessage.tsx', import.meta.url), 'utf8')
const taskDetailHeaderSource = await readFile(new URL('../src/components/TaskDetailHeader.tsx', import.meta.url), 'utf8')
const assistantSource = await readFile(new URL('../src/components/AssistantChatPanel.tsx', import.meta.url), 'utf8')

test('task cards and detail headers show the creator name', () => {
  assert.match(taskListSource, /task\.creator_name/)
  assert.match(taskListSource, /taskList\.creator/)
  assert.match(taskDetailHeaderSource, /task\.creator_name/)
  assert.match(taskDetailHeaderSource, /taskDetail\.creator/)
})

test('user messages show the stored author name instead of hiding self behind 我', () => {
  assert.match(assistantSource, /const userSender = displayUserSender\(message\.author_name, userName, copy\.me\)/)
  assert.match(assistantSource, /<MarqueeText text=\{userSender\} className="user-sender-marquee" \/>/)
  assert.match(taskDetailSource, /displayUserSender\(\s*msg\.author_name,\s*localUserName,\s*t\('aiFlow\.me'\),\s*\)/)
  assert.match(taskDetailSource, /<MarqueeText text=\{sender\} className="user-sender-marquee" \/>/)
})

test('live coordinator user messages render with their author instead of as the agent', () => {
  assert.match(taskDetailSource, /const isUser =\s*msg\.role === 'user'/)
  assert.match(taskDetailSource, /role=\{[\s\S]*?isUser\s*\? 'user'\s*: 'assistant'/)
  assert.match(taskDetailSource, /displayUserSender\(\s*msg\.author_name,\s*localUserName,\s*t\('aiFlow\.me'\),\s*\)/)
})
