import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

import ToolTimelineItem from '../src/components/ToolTimelineItem.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'
import type { ToolActivity } from '../src/utils/messageTimeline.ts'

function command(
  id: string,
  startedAt: number,
  endedAt: number,
): ToolActivity {
  return {
    id,
    name: 'Bash',
    input: { command: `echo ${id}` },
    result: id,
    hasResult: true,
    isError: false,
    startedAt,
    endedAt,
  }
}

function render(item: Parameters<typeof ToolTimelineItem>[0]['item']) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ToolTimelineItem item={item} streaming={false} now={1_700_000_000_000} />
    </I18nProvider>,
  )
}

test('shows a duration beside each completed command', () => {
  const html = render({
    type: 'tool',
    id: 'tool-cmd-1',
    activity: command('cmd-1', 1_700_000_000_000, 1_700_000_003_000),
  })

  assert.match(html, /class="llm-tool-call-summary">已运行命令 · 3秒<\/span>/)
})

test('shows the wall-clock duration of a completed command group', () => {
  const html = render({
    type: 'tool-group',
    id: 'tool-group-cmd-1',
    activities: [
      command('cmd-1', 1_700_000_000_000, 1_700_000_003_000),
      command('cmd-2', 1_700_000_003_000, 1_700_000_008_000),
    ],
  })

  assert.match(html, /class="llm-tool-call-summary">执行 2 条命令 · 8秒<\/span>/)
  assert.match(html, /class="llm-tool-call-summary">已运行命令 · 3秒<\/span>/)
  assert.match(html, /class="llm-tool-call-summary">已运行命令 · 5秒<\/span>/)
})
