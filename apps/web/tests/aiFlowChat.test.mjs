import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const chatSource = await readFile(
  new URL('../src/components/AiFlowChat.tsx', import.meta.url),
  'utf8',
)
const panelSource = await readFile(
  new URL('../src/components/AssistantChatPanel.tsx', import.meta.url),
  'utf8',
)
const bubbleSource = await readFile(
  new URL('../src/components/ChatMessageBubble.tsx', import.meta.url),
  'utf8',
)
const a2uiMessageSource = await readFile(
  new URL('../src/components/A2uiMessage.tsx', import.meta.url),
  'utf8',
)
const storeSource = await readFile(
  new URL('../src/stores/assistantStore.ts', import.meta.url),
  'utf8',
)
const a2uiUtilSource = await readFile(
  new URL('../src/utils/a2ui.ts', import.meta.url),
  'utf8',
)

test('AI flow chat subscribes the session before invoking the engine', () => {
  assert.match(chatSource, /import \{ flushWsSubscriptionNow \} from '\.\.\/hooks\/useWebSocket'/)
  const sendIndex = chatSource.indexOf('const send = useCallback')
  const chatApiIndex = chatSource.indexOf('workflowGenApi.chat(')
  const flushIndex = chatSource.indexOf('flushWsSubscriptionNow()')
  assert.ok(sendIndex !== -1, 'send() exists')
  assert.ok(chatApiIndex !== -1, 'workflowGenApi.chat() exists')
  assert.ok(
    flushIndex !== -1 && flushIndex > sendIndex && flushIndex < chatApiIndex,
    'flushWsSubscriptionNow() runs between send() start and the chat API call',
  )
})

test('AI flow chat hides duplicate apply-flow UI when proposal cards are shown', () => {
  assert.match(chatSource, /hideApplyFlow=\{shouldShowA2uiProposalCards\(latestProposals\.length, appliedCardId\)\}/)
})

test('assistant panel forwards hideApplyFlow and re-scrolls when A2UI mounts', () => {
  assert.match(panelSource, /hideApplyFlow\?: boolean/)
  assert.match(panelSource, /hideApplyFlow=\{hideApplyFlow\}/)
  assert.match(panelSource, /messages\.length, lastContent, scrollKey, a2uiMessages\]/)
  assert.match(bubbleSource, /hideApplyFlow\?: boolean/)
  assert.match(bubbleSource, /hideApplyFlow=\{hideApplyFlow\}/)
  assert.match(a2uiMessageSource, /hideApplyFlow\?: boolean/)
  assert.match(a2uiMessageSource, /withoutApplyFlowSurfaces/)
})

test('assistant store hydrates proposals and a2ui payloads from history', () => {
  assert.match(storeSource, /latestProposals = proposals/)
  assert.match(storeSource, /rejectionMessage = config\.rejectionMessageExtractor/)
  assert.match(storeSource, /a2uiMessages\[message\.id\] = a2uiPayloads/)
})

test('a2ui util exports the apply-flow surface filter', () => {
  assert.match(a2uiUtilSource, /export function withoutApplyFlowSurfaces/)
  assert.match(a2uiUtilSource, /name === 'apply_flow'/)
})
