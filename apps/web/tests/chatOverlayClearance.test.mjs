import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const hookSource = await readFile(
  new URL('../src/hooks/useComposerOverlayClearance.ts', import.meta.url),
  'utf8',
)
const pendingSource = await readFile(
  new URL('../src/components/PendingMessageInserts.tsx', import.meta.url),
  'utf8',
)
const taskDetailSource = await readFile(
  new URL('../src/components/TaskDetailView.tsx', import.meta.url),
  'utf8',
)
const panelSource = await readFile(
  new URL('../src/components/AssistantChatPanel.tsx', import.meta.url),
  'utf8',
)

test('composer overlay clearance lives in one shared hook', () => {
  assert.match(hookSource, /export function useComposerOverlayClearance/)
  assert.match(hookSource, /export const ComposerOverlayHostContext/)
  // 高度测量、底部留白、跟随钉底都只在 hook 里实现一次
  assert.equal(hookSource.match(/new ResizeObserver/g)?.length, 1)
  assert.match(hookSource, /overlayHeight \+ OVERLAY_GAP/)
})

test('task transcript bottom clearance scrolls with the content', async () => {
  const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')
  const contentRule = css.match(/\.chat-history-content\s*\{([^}]+)\}/)?.[1] ?? ''
  const scrollRule = css.match(/\.task-chat-history-scroll\s*\{([^}]+)\}/)?.[1] ?? ''
  assert.match(contentRule, /padding-bottom:\s*20px/)
  assert.match(contentRule, /flex-shrink:\s*0/)
  assert.match(scrollRule, /padding-block:\s*20px\s+0/)
  const assistantScrollRule = css.match(/\.chat-history-scroll--assistant\s*\{([^}]+)\}/)?.[1] ?? ''
  assert.match(assistantScrollRule, /padding-block:\s*10px\s+0/)
  assert.doesNotMatch(panelSource, /paddingBlock: 10/)
  const mobileCss = await readFile(new URL('../src/mobile.css', import.meta.url), 'utf8')
  assert.match(mobileCss, /\.chat-history-scroll\s*\{\s*padding-block:\s*6px\s+0\s*!important/)
})
