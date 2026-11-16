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

for (const input of [
  { command: 'workstep memory search --query 发布' },
  { cmd: 'uv run --no-sync --directory apps/daemon python -m cli memory search --query 发布' },
  { command: 'cd /workspace && env LANG=zh_CN rtk proxy uv run --directory "/path with spaces" python -m cli memory search --query 发布' },
  { command: '"$WORKSTEP_CLI_PYTHON" "$WORKSTEP_DAEMON_DIR/cli.py" memory search --query 发布' },
  { cmd: ['bash', '-lc', 'uv run --no-sync --directory apps/daemon python -m cli memory search --query 发布'] },
  JSON.stringify({ command: 'python3 /Applications/WorkStep/cli.py memory search --query 发布' }),
]) {
  test(`names memory CLI searches by purpose: ${JSON.stringify(input)}`, () => {
    for (const state of ['running', 'done', 'failed']) {
      const activity = { ...command('search', 1000, 2000), input, hasResult: state !== 'running', isError: state === 'failed' }
      const html = renderToStaticMarkup(<I18nProvider><ToolTimelineItem item={{ type: 'tool', id: 'search', activity }} streaming={state === 'running'} now={2000} /></I18nProvider>)
      assert.match(html, />搜索记忆 ·/)
      assert.doesNotMatch(html, /已运行命令/)
    }
  })
}

test('does not mistake quoted text for a memory search command', () => {
  for (const text of ['echo "workstep memory search"', 'printf "%s" "python -m cli memory search"', 'rg "memory search" .', 'workstep memory read --id memory:1']) {
    const html = render({ type: 'tool', id: 'ordinary', activity: { ...command('ordinary', 1000, 2000), input: { command: text } } })
    assert.match(html, /已运行命令/)
    assert.doesNotMatch(html, /搜索记忆/)
  }
})

test('labels a group of memory searches without changing mixed command groups', () => {
  const search = { ...command('search', 1000, 2000), input: { cmd: 'rtk proxy uv run --no-sync python -m cli memory search --query 发布' } }
  const html = render({ type: 'tool-group', id: 'searches', activities: [search, { ...search, id: 'search-2' }] })
  assert.equal((html.match(/>搜索记忆 ·/g) || []).length, 3)
  assert.doesNotMatch(html, /执行 2 条命令/)
  const mixed = render({ type: 'tool-group', id: 'mixed', activities: [search, command('other', 2000, 3000)] })
  assert.match(mixed, /执行 2 条命令/)
})
