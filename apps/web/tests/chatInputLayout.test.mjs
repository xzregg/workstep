import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/ChatInput.tsx', import.meta.url), 'utf8')
const assistantPanel = await readFile(new URL('../src/components/AssistantChatPanel.tsx', import.meta.url), 'utf8')
const taskDetail = await readFile(new URL('../src/components/TaskDetailView.tsx', import.meta.url), 'utf8')
const taskDetailPage = await readFile(new URL('../src/pages/TaskDetail.tsx', import.meta.url), 'utf8')
const chatPage = await readFile(new URL('../src/pages/ChatPage.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')
const mobileCss = await readFile(new URL('../src/mobile.css', import.meta.url), 'utf8')

test('shared chat input stays centered and leaves room on wide conversations', () => {
  assert.match(source, /className="chat-input-root"/)
  assert.match(css, /\.chat-input-root,\s*\.chat-quick-prompts\s*\{[^}]*width:\s*100%/s)
})

test('mobile chat input keeps the engine quota visible in the scrollable toolbar', () => {
  assert.match(mobileCss, /\.chat-input-quota-refresh,/)
  assert.doesNotMatch(mobileCss, /\.chat-input-quota\s*\{[^}]*display:\s*none/s)
})

test('chat input toolbar wraps controls instead of overflowing narrow composers', () => {
  assert.match(source, /className="chat-input-toolbar"/)
  assert.match(css, /\.chat-input-toolbar\s*\{[^}]*flex-wrap:\s*wrap/s)
})

test('task detail places the optional reset-step control in the shared composer', () => {
  assert.match(source, /resetStep\?: ChatInputResetStep/)
  assert.match(source, /data-reset-step/)
  assert.ok(source.indexOf('data-reset-step') > source.indexOf('className="chat-input-attach"'))
  assert.match(taskDetail, /resetStep=\{\(resumableTarget \|\| chatTarget === 'coordinator'\)/)
  assert.match(taskDetailPage, /resumeStepWithMessage\([\s\S]*resetSession/)
  assert.match(taskDetailPage, /resetSession:\s*resetStep/)
})

test('mobile chat input controls scroll only within the space before the send button', () => {
  assert.match(source, /className="chat-input-toolbar-scroll"/)
  assert.match(mobileCss, /\.chat-input-toolbar-scroll\s*\{[^}]*flex:\s*1 1 auto[^}]*min-width:\s*0[^}]*overflow-x:\s*auto/s)
  assert.match(mobileCss, /\.chat-input-toolbar\s*\{[^}]*overflow:\s*hidden/s)
  assert.match(mobileCss, /\.chat-input-send\s*\{[^}]*flex:\s*0 0 var\(--mobile-control-composer\)/s)
  assert.doesNotMatch(mobileCss, /\.chat-input-send\s*\{[^}]*position:\s*sticky/s)
})
test('mobile task header keeps the compact id beside the share action', () => {
  assert.match(taskDetailPage, /className="task-detail-share-button"/)
  assert.match(taskDetailPage, /className="task-detail-id-button"/)
  assert.match(mobileCss, /\.task-detail-id-button\s*\{[^}]*max-width:\s*180px[^}]*text-overflow:\s*ellipsis/s)
})

test('session chat composes engine quota with its shared input', () => {
  assert.match(chatPage, /useEngineQuota\(\s*activeProject\?\.id, effectiveEngine, running/)
  assert.match(chatPage, /onRefreshQuota=\{\(\) => \{ void refreshQuota\(\) \}\}/)
  assert.match(chatPage, /quotaRefreshing=\{quotaRefreshing\}/)
  assert.match(assistantPanel, /onRefreshQuota=\{onRefreshQuota\}/)
})
