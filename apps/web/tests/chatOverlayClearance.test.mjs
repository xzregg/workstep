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

test('every conversation view consumes the hook instead of duplicating it', () => {
  for (const source of [taskDetailSource, panelSource]) {
    assert.match(source, /useComposerOverlayClearance\(\{/)
    // 留白落在「包裹 chat-history-scroll 的 div」上，而不是滚动容器自己
    assert.match(source, /position: 'relative',\s*paddingBottom: overlayPaddingBottom\(10\)/)
    assert.match(source, /ComposerOverlayHostContext\.Provider value=\{registerOverlay\}/)
    // 滚动容器保持常规内边距，不承载动态留白；留白表达式全文件只出现一次（包裹层）
    assert.match(source, /paddingBlock: \d+/)
    assert.equal(source.match(/overlayPaddingBottom\(\d+\)/g)?.length, 1)
    // 不再各自手写测量 / 钉底 effect
    assert.doesNotMatch(source, /insertsPanelHeight|setInsertsPanelHeight/)
  }
  // 面板自行注册到宿主，不再要求每个调用点透传 ref
  assert.match(pendingSource, /useContext\(ComposerOverlayHostContext\)/)
  assert.doesNotMatch(pendingSource, /containerRef/)
  assert.doesNotMatch(taskDetailSource, /containerRef=\{/)
})
