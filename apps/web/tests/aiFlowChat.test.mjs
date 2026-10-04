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

test('AI flow chat keeps message-embedded apply-flow controls when proposals arrive', () => {
  assert.doesNotMatch(chatSource, /hideApplyFlow=/)
  assert.match(chatSource, /onA2uiAction=\{handleA2uiAction\}/)
})

test('assistant panel forwards embedded A2UI actions and re-scrolls when A2UI mounts', () => {
  assert.match(panelSource, /messages\.length, lastContent, lastEventsCount, scrollKey, a2uiMessages\]/)
  assert.match(panelSource, /onA2uiAction=\{canEdit \? onA2uiAction : undefined\}/)
  assert.match(bubbleSource, /onAction=\{onA2uiAction\}/)
  assert.doesNotMatch(a2uiMessageSource, /withoutApplyFlowSurfaces/)
})

test('assistant store hydrates proposals and a2ui payloads from history', () => {
  assert.match(storeSource, /latestProposals = proposals/)
  assert.match(storeSource, /rejectionMessage = config\.rejectionMessageExtractor/)
  assert.match(storeSource, /a2uiMessages\[message\.id\] = a2uiPayloads/)
})

test('auto-applied patches merge onto the latest live canvas', () => {
  assert.match(chatSource, /applyWorkflowPatch\(currentSteps, proposal\.patch, null\)/)
  assert.match(chatSource, /getCanvasStepsRef\.current\?\.\(\)/)
  assert.match(chatSource, /applyFlowSteps\(steps, card\.id, false\)/)
})
