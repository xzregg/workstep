import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const chatBubbleSource = await readFile(
  new URL('../src/components/ChatMessageBubble.tsx', import.meta.url),
  'utf8',
)
const assistantPanelSource = await readFile(
  new URL('../src/components/AssistantChatPanel.tsx', import.meta.url),
  'utf8',
)
const taskDetailSource = await readFile(
  new URL('../src/components/TaskDetailView.tsx', import.meta.url),
  'utf8',
)
const processTraceSource = await readFile(
  new URL('../src/components/ProcessTrace.tsx', import.meta.url),
  'utf8',
)
const styles = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

test('conversation loading entry points share the text-only status component', () => {
  for (const source of [chatBubbleSource, assistantPanelSource, taskDetailSource, processTraceSource]) {
    assert.doesNotMatch(source, /engine-loading-dots/)
  }
  assert.match(assistantPanelSource, /StreamingStatusText/)
  assert.match(taskDetailSource, /StreamingStatusText/)
  assert.match(processTraceSource, /StreamingStatusText/)
  assert.doesNotMatch(styles, /\.engine-loading-dots/)
})