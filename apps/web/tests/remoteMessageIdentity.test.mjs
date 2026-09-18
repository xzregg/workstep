import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const bubbleSource = fs.readFileSync(new URL('../src/components/ChatMessageBubble.tsx', import.meta.url), 'utf8')
const taskDetailSource = fs.readFileSync(new URL('../src/components/TaskDetailView.tsx', import.meta.url), 'utf8')
const assistantSource = fs.readFileSync(new URL('../src/components/AssistantChatPanel.tsx', import.meta.url), 'utf8')
const styles = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

test('remote user avatars expose identity without a native tooltip', () => {
  assert.match(bubbleSource, /senderTitle\?: string/)
  assert.match(bubbleSource, /const label = senderTitle \|\| sender/)
  assert.match(bubbleSource, /aria-label=\{label\}/)
  assert.doesNotMatch(bubbleSource, /title=\{senderTitle \|\| sender\}/)
  assert.doesNotMatch(bubbleSource, /from 'antd'/)
  assert.match(bubbleSource, /className="chat-message-avatar-tooltip-wrap"[\s\S]*<MarqueeText text=\{label\} forceActive speed=\{48\} \/>/)
  assert.match(taskDetailSource, /senderTitle=\{\s*isUser\s*\? displayUserDetail/)
  assert.match(
    assistantSource,
    /senderTitle=\{\s*message\.role === 'user'\s*\? displayUserDetail/,
  )
  assert.doesNotMatch(
    taskDetailSource,
    /senderTitle=\{isUser[\s\S]{0,200}\$\{sender\} ·/,
  )
  assert.doesNotMatch(
    assistantSource,
    /senderTitle=\{message\.role === 'user'[\s\S]{0,200}\$\{userSender\} ·/,
  )
})

test('hovering a user message row scrolls an overflowing sender name', () => {
  assert.match(taskDetailSource, /<MarqueeText text=\{sender\} className="user-sender-marquee" \/>/g)
  assert.match(assistantSource, /<MarqueeText text=\{userSender\} className="user-sender-marquee" \/>/)
  assert.match(styles, /\.chat-message-row:hover \.ws-marquee\.user-sender-marquee\.is-overflowing \.ws-marquee__inner/)
})

test('own user messages hide the sender label but keep the timestamp', () => {
  assert.match(
    taskDetailSource,
    /sender !== t\('aiFlow\.me'\) && \(\s*<MarqueeText text=\{sender\} className="user-sender-marquee" \/>/,
  )
  assert.match(
    assistantSource,
    /userSender !== copy\.me && \(\s*<MarqueeText text=\{userSender\} className="user-sender-marquee" \/>/,
  )
})
