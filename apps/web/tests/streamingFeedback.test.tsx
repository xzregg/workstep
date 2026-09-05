import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

import ProcessTrace from '../src/components/ProcessTrace.tsx'
import StreamingStatusText from '../src/components/StreamingStatusText.tsx'
import ToolCallRow from '../src/components/ToolCallRow.tsx'
import ToolTimelineItem from '../src/components/ToolTimelineItem.tsx'
import { I18nProvider, zhCNT } from '../src/i18n/index.tsx'

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

function render(node: React.ReactNode) {
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>)
}


test('active thinking disclosure reports elapsed time and character count', () => {
  const startedAt = Date.now() - 2_500
  const html = render(
    <ProcessTrace
      running
      startedAt={startedAt}
      events={[{
        type: 'thinking_delta',
        data: { delta: '正在分析现有组件。' },
        timestamp: startedAt,
      }]}
    />,
  )

  assert.match(html, /思考中 · \d+秒 · 9 字符/)
  assert.match(html, /class="process-trace-thinking-block"[^>]*open=""/)
})

test('running tool uses a static icon and shimmering text instead of a spinner', () => {
  const html = render(
    <ToolCallRow
      messageRunning
      activity={{
        id: 'tool-1',
        name: 'exec_command',
        input: { cmd: 'rg loading' },
        hasResult: false,
        isError: false,
      }}
    />,
  )

  assert.match(html, /class="llm-tool-call-summary is-shimmer"/)
  assert.match(html, /正在执行工具：exec_command/)
  assert.doesNotMatch(html, /task-status-spinner/)
})

test('running tool group uses the same static icon and shimmering status', () => {
  const html = render(
    <ToolTimelineItem
      streaming
      item={{
        type: 'tool-group',
        id: 'tools-1',
        activities: [{
          id: 'tool-1',
          name: 'exec_command',
          hasResult: false,
          isError: false,
        }, {
          id: 'tool-2',
          name: 'read_file',
          hasResult: true,
          isError: false,
        }],
      }}
    />,
  )

  assert.match(html, /class="llm-tool-call-summary is-shimmer"/)
  assert.doesNotMatch(html, /task-status-spinner/)
})

test('streaming feedback is unframed and uses the approved motion timing', () => {
  const loadingRule = styles.match(/\.engine-loading-message\s*\{([\s\S]*?)\}/)?.[1] || ''
  const cursorRule = styles.match(/\.markdown-stream-cursor\s*\{([\s\S]*?)\}/)?.[1] || ''

  assert.doesNotMatch(loadingRule, /\b(?:padding|border|background)\s*:/)
  assert.match(styles, /\.engine-loading-message\.is-shimmer,[\s\S]*\.llm-tool-call-summary\.is-shimmer[\s\S]*animation:\s*streaming-status-shimmer 1\.55s/)
  assert.match(cursorRule, /width:\s*4px/)
  assert.match(cursorRule, /animation:\s*markdown-cursor-pulse 620ms/)
})

test('conversation loading entry points share the text-only status component', () => {
  for (const source of [chatBubbleSource, assistantPanelSource, taskDetailSource, processTraceSource]) {
    assert.doesNotMatch(source, /engine-loading-dots/)
  }
  assert.match(assistantPanelSource, /StreamingStatusText/)
  assert.match(taskDetailSource, /StreamingStatusText/)
  assert.match(processTraceSource, /StreamingStatusText/)
  assert.doesNotMatch(styles, /\.engine-loading-dots/)
})
