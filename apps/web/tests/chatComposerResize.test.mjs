import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const panelSource = await readFile(new URL('../src/components/AssistantChatPanel.tsx', import.meta.url), 'utf8')
const chatPageSource = await readFile(new URL('../src/pages/ChatPage.tsx', import.meta.url), 'utf8')
const aiFlowSource = await readFile(new URL('../src/components/AiFlowChat.tsx', import.meta.url), 'utf8')
const aiTaskSource = await readFile(new URL('../src/components/AiTaskCreateChat.tsx', import.meta.url), 'utf8')

test('assistant chat panel exposes a draggable composer divider', () => {
  assert.match(panelSource, /role="separator"/)
  assert.match(panelSource, /aria-orientation="horizontal"/)
  assert.match(panelSource, /cursor: 'row-resize'/)
  assert.match(panelSource, /tabIndex=\{0\}/)
  assert.match(panelSource, /onMouseDown=\{startComposerResize\}/)
  assert.match(panelSource, /onDoubleClick=\{resetComposerHeight\}/)
  assert.match(panelSource, /onKeyDown=\{handleComposerResizeKey\}/)
})

test('composer height is clamped between a 220px minimum and a panel fraction', () => {
  assert.match(panelSource, /MIN_COMPOSER_HEIGHT = 220/)
  assert.match(panelSource, /MAX_COMPOSER_FRACTION = 0\.85/)
  assert.match(panelSource, /Math\.min\(Math\.max\(MIN_COMPOSER_HEIGHT, height\), max\)/)
})

test('composer height persists via localStorage and resets to auto on double-click', () => {
  assert.match(panelSource, /workstep-chat-composer-height/)
  assert.match(panelSource, /localStorage\.setItem\(COMPOSER_HEIGHT_KEY/)
  assert.match(panelSource, /localStorage\.removeItem\(COMPOSER_HEIGHT_KEY\)/)
  assert.match(panelSource, /const resetComposerHeight = \(\) => setComposerHeight\(null\)/)
})

test('all assistant chats keep using the shared resizable panel', () => {
  assert.match(chatPageSource, /AssistantChatPanel/)
  assert.doesNotMatch(chatPageSource, /row-resize/)
  assert.match(aiFlowSource, /AssistantChatPanel/)
  assert.doesNotMatch(aiFlowSource, /row-resize/)
  assert.match(aiTaskSource, /AssistantChatPanel/)
  assert.doesNotMatch(aiTaskSource, /row-resize/)
})

test('resize handle copy exists in every locale', async () => {
  for (const file of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP']) {
    const source = await readFile(new URL(`../src/i18n/locales/${file}.ts`, import.meta.url), 'utf8')
    assert.match(source, /dragResizeComposer: /)
  }
})
