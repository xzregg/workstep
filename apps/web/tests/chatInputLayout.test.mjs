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

test('mobile chat input keeps the engine quota visible in the scrollable toolbar', () => {
  assert.match(source, /chat-input-context chat-input-quota/)
  assert.match(mobileCss, /\.chat-input-quota-refresh,/)
  assert.doesNotMatch(mobileCss, /\.chat-input-quota\s*\{[^}]*display:\s*none/s)
})

test('engine quota opens its detail panel on click like context usage', () => {
  assert.match(source, /ref=\{quotaRef\}/)
  assert.match(source, /chat-input-quota\$\{quotaTipOpen \? ' is-tip-open' : ''\}/)
  assert.match(source, /setQuotaTipOpen\(\(open\) => !open\)/)
  assert.match(source, /chat-input-context-tip chat-input-quota-tip" style=\{quotaTipStyle\}/)
})

test('chat input toolbar wraps controls instead of overflowing narrow composers', () => {
  assert.match(source, /className="chat-input-toolbar"/)
  assert.match(css, /\.chat-input-toolbar\s*\{[^}]*flex-wrap:\s*wrap/s)
})

test('mobile chat input controls scroll only within the space before the send button', () => {
  assert.match(source, /className="chat-input-toolbar-scroll"/)
  assert.match(mobileCss, /\.chat-input-toolbar-scroll\s*\{[^}]*flex:\s*1 1 auto[^}]*min-width:\s*0[^}]*overflow-x:\s*auto/s)
  assert.match(mobileCss, /\.chat-input-toolbar\s*\{[^}]*overflow:\s*hidden/s)
  assert.match(mobileCss, /\.chat-input-send\s*\{[^}]*flex:\s*0 0 32px/s)
  assert.doesNotMatch(mobileCss, /\.chat-input-send\s*\{[^}]*position:\s*sticky/s)
})

test('mobile task composer sits at the bottom with two-pixel padding and a blurred history edge', () => {
  assert.match(taskDetail, /\{\/\* Chat input \(edit mode only\) \*\/\}[\s\S]*?className="task-detail-composer"/)
  assert.match(taskDetail, /className="task-chat-history-wrapper"/)
  assert.match(mobileCss, /\.task-detail-composer\s*\{[^}]*padding:\s*2px 2px max\(2px, env\(safe-area-inset-bottom\)\)/s)
  assert.match(mobileCss, /\.task-detail-composer \.chat-input-root\s*\{[^}]*padding:\s*2px/s)
  assert.match(mobileCss, /\.task-chat-history-wrapper::after\s*\{[^}]*backdrop-filter:\s*blur\(10px\)/s)
})

test('mobile task header keeps the compact id beside the share action', () => {
  assert.match(taskDetailPage, /className="task-detail-share-button"/)
  assert.match(taskDetailPage, /className="task-detail-id-button"/)
  assert.match(mobileCss, /\.task-detail-id-button\s*\{[^}]*max-width:\s*180px[^}]*text-overflow:\s*ellipsis/s)
})

test('session chat requests quota on entry and after an engine run finishes', () => {
  assert.match(chatPage, /engineApi\.quota/)
  assert.match(chatPage, /if \(running \|\| !activeProject\?\.id\) \{/)
  assert.match(chatPage, /\[running, activeProject\?\.id, refreshQuota\]/)
})

test('session chat wires an explicit loading-aware quota refresh action', () => {
  assert.match(chatPage, /const refreshQuota = useCallback\(async \(\) =>/)
  assert.match(chatPage, /onRefreshQuota=\{\(\) => \{ void refreshQuota\(\) \}\}/)
  assert.match(chatPage, /quotaRefreshing=\{quotaRefreshing\}/)
  assert.match(assistantPanel, /onRefreshQuota=\{onRefreshQuota\}/)
})
