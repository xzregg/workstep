import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import MessageResponseFooter, {
  firstTokenDelaySeconds,
  formatSeconds,
  tokensPerSecond,
} from '../src/components/MessageResponseFooter'
import AssistantThinkingMessage from '../src/components/AssistantThinkingMessage'
import { I18nProvider } from '../src/i18n'

const assistantPanelSource = await readFile(
  new URL('../src/components/AssistantChatPanel.tsx', import.meta.url),
  'utf8',
)
const taskDetailSource = await readFile(
  new URL('../src/components/TaskDetailView.tsx', import.meta.url),
  'utf8',
)

function setup() {
  const window = new Window()
  Object.assign(globalThis, {
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const root = createRoot(
    window.document.body.appendChild(window.document.createElement('div')),
  )
  return { window, root }
}

/** 渲染并断言 footer 摘要；结束后必须卸载，否则 running 态的 1s 计时器会挂住测试进程。 */
async function renderSummary(node: React.ReactNode) {
  const { window, root } = setup()
  try {
    await act(async () => {
      root.render(<I18nProvider>{node}</I18nProvider>)
    })
    return window.document.querySelector('.footer-usage-summary')?.textContent ?? ''
  } finally {
    await act(async () => { root.unmount() })
  }
}

test('tokensPerSecond needs at least one second and some output', () => {
  assert.equal(tokensPerSecond(0, 5000), null)
  assert.equal(tokensPerSecond(120, 500), null)
  assert.equal(tokensPerSecond(120, null), null)
  assert.equal(tokensPerSecond(120, 4000), 30)
  // 慢于 1 t/s 时也显示 1，避免出现「0 t/s」。
  assert.equal(tokensPerSecond(1, 60_000), 1)
})

test('running footer shows estimated tokens, rate and engine * model', async () => {
  const startedAt = Date.now() - 5000
  const summary = await renderSummary((
    <MessageResponseFooter
      content="hello"
      events={[
        { type: 'TEXT_MESSAGE_CHUNK', delta: 'hello world '.repeat(40), timestamp: new Date(startedAt).toISOString() },
        { type: 'TEXT_MESSAGE_CHUNK', delta: 'more output '.repeat(40), timestamp: new Date(startedAt + 1000).toISOString() },
      ]}
      engine="pydantic_ai"
      model="mtplx-qwen38-27b-optimized-speed"
      startedAt={startedAt}
      running
    />
  ))
  assert.match(summary, /Token/)
  assert.match(summary, /\d+ t\/s/)
  assert.match(summary, /Pydantic AI \* mtplx-qwen38-27b-optimized-speed/)
})

test('stopped footer keeps estimating tokens from the received events', async () => {
  const startedAt = Date.now() - 5000
  const summary = await renderSummary((
    <MessageResponseFooter
      content="hello"
      events={[
        { type: 'TEXT_MESSAGE_CHUNK', delta: 'hello world '.repeat(40), timestamp: new Date(startedAt).toISOString() },
        { type: 'TEXT_MESSAGE_CHUNK', delta: 'more output '.repeat(40), timestamp: new Date(startedAt + 1000).toISOString() },
      ]}
      engine="pydantic_ai"
      model="model-x"
      startedAt={startedAt}
      stopped
    />
  ))
  assert.match(summary, /Token/)
  assert.match(summary, /输入 0/)
  assert.match(summary, /输出 [1-9][0-9]*/)
  assert.match(summary, /总计 [1-9][0-9]*/)
  assert.match(summary, /≈/)
  assert.doesNotMatch(summary, /暂无数据/)
  assert.doesNotMatch(summary, /t\/s/)
})

test('stopped footer estimates tokens from persisted content after refresh', async () => {
  const summary = await renderSummary((
    <MessageResponseFooter
      content="这是刷新后仍然保留的停止消息正文"
      events={[]}
      engine="claude_code"
      model="qwen3.8-max"
      stopped
    />
  ))
  assert.match(summary, /输出 [1-9][0-9]*/)
  assert.match(summary, /总计 [1-9][0-9]*/)
  assert.match(summary, /≈/)
  assert.doesNotMatch(summary, /暂无数据/)
})

test('stopped footer restores token estimates from a thought-only history summary', async () => {
  const summary = await renderSummary((
    <MessageResponseFooter
      content=""
      events={[]}
      eventSummary={{ thought_characters: 1007, commentary_characters: 0 }}
      engine="claude_code"
      model="qwen3.8-max"
      stopped
    />
  ))
  assert.match(summary, /输出 [1-9][0-9]*/)
  assert.match(summary, /总计 [1-9][0-9]*/)
  assert.match(summary, /≈/)
  assert.doesNotMatch(summary, /暂无数据/)
})

test('running footer falls back to the earliest event timestamp for the rate', async () => {
  const startedAt = Date.now() - 4000
  const summary = await renderSummary((
    <MessageResponseFooter
      content="hello"
      events={[
        { type: 'TEXT_MESSAGE_CHUNK', delta: 'abc '.repeat(200), timestamp: new Date(startedAt).toISOString() },
      ]}
      engine="pydantic_ai"
      model="model-x"
      running
    />
  ))
  assert.match(summary, /\d+ t\/s/)
  assert.match(summary, /Pydantic AI \* model-x/)
})

test('running footer still shows engine and model before any token data arrives', async () => {
  const summary = await renderSummary((
    <MessageResponseFooter
      content=""
      engine="pydantic_ai"
      model="model-x"
      startedAt={Date.now()}
      running
    />
  ))
  assert.equal(summary, 'Pydantic AI * model-x')
})

test('thinking phase (no visible reply yet) still reports tokens, rate and engine * model', async () => {
  const startedAt = Date.now() - 6000
  const summary = await renderSummary((
    <MessageResponseFooter
      content=""
      events={[
        { type: 'REASONING_MESSAGE_CHUNK', delta: '让我想想 '.repeat(120), timestamp: new Date(startedAt).toISOString() },
      ]}
      engine="pydantic_ai"
      model="mtplx-qwen38-27b-optimized-speed"
      startedAt={startedAt}
      running
    />
  ))
  assert.match(summary, /Token/)
  assert.match(summary, /\d+ t\/s/)
  assert.match(summary, /Pydantic AI \* mtplx-qwen38-27b-optimized-speed/)
})

test('firstTokenDelaySeconds measures start → first output event', () => {
  const start = Date.now() - 60_000
  const iso = (offset: number) => new Date(start + offset).toISOString()
  const events = [
    { type: 'RUN_STARTED', timestamp: iso(0) },
    { type: 'TOOL_CALL_START', timestamp: iso(1200) },
    { type: 'REASONING_MESSAGE_CHUNK', delta: '想', timestamp: iso(5000) },
    { type: 'TEXT_MESSAGE_CHUNK', delta: 'hi', timestamp: iso(9000) },
  ]
  assert.equal(firstTokenDelaySeconds(events, start), 5)
  // 无 startedAt 时回退到最早事件（RUN_STARTED）。
  assert.equal(firstTokenDelaySeconds(events), 5)
  // 还没吐词 / 没有可用时间戳时不显示。
  assert.equal(firstTokenDelaySeconds([{ type: 'RUN_STARTED', timestamp: iso(0) }], start), null)
  assert.equal(firstTokenDelaySeconds([], start), null)
  assert.equal(firstTokenDelaySeconds(undefined, start), null)
})

test('formatSeconds keeps one decimal under ten seconds', () => {
  assert.equal(formatSeconds(4.83), '4.8')
  assert.equal(formatSeconds(5), '5')
  assert.equal(formatSeconds(0.24), '0.2')
  assert.equal(formatSeconds(12.4), '12')
})

test('running footer reports the first-token delay alongside the rate', async () => {
  const startedAt = Date.now() - 8000
  const summary = await renderSummary((
    <MessageResponseFooter
      content="hi"
      events={[
        { type: 'REASONING_MESSAGE_CHUNK', delta: '让我想想 '.repeat(120), timestamp: new Date(startedAt + 5000).toISOString() },
        { type: 'TEXT_MESSAGE_CHUNK', delta: 'hi', timestamp: new Date(startedAt + 6000).toISOString() },
      ]}
      engine="pydantic_ai"
      model="mtplx-qwen38-27b-optimized-speed"
      startedAt={startedAt}
      running
    />
  ))
  assert.match(summary, /\d+ t\/s · 首t 5秒/)
  assert.match(summary, /Pydantic AI \* mtplx-qwen38-27b-optimized-speed/)
  // 顺序：Token → t/s → 首t → 引擎 * 模型
  assert.ok(summary.indexOf('Token') < summary.indexOf('t/s'))
  assert.ok(summary.indexOf('t/s') < summary.indexOf('首t'))
  assert.ok(summary.indexOf('首t') < summary.indexOf('Pydantic AI'))
})

test('finished footer keeps the first-token delay', async () => {
  const startedAt = Date.now() - 60_000
  const summary = await renderSummary((
    <MessageResponseFooter
      content="hi"
      usage={{ input_tokens: 100, output_tokens: 50, total_tokens: 150 }}
      events={[
        { type: 'TEXT_MESSAGE_CHUNK', delta: 'hi', timestamp: new Date(startedAt + 12_400).toISOString() },
      ]}
      engine="pydantic_ai"
      model="model-x"
      startedAt={startedAt}
      endedAt={Date.now()}
    />
  ))
  assert.match(summary, /首t 12秒/)
  assert.doesNotMatch(summary, /t\/s/)
})

test('optimistic thinking placeholder can carry the usage footer', async () => {
  const summary = await renderSummary((
    <AssistantThinkingMessage
      sender="AI"
      initials="AI"
      footer={(
        <MessageResponseFooter
          content=""
          engine="pydantic_ai"
          model="model-x"
          running
        />
      )}
    />
  ))
  assert.equal(summary, 'Pydantic AI * model-x')
})

test('conversation containers render the footer while thinking, not only after content arrives', () => {
  for (const source of [assistantPanelSource, taskDetailSource]) {
    // footer 不能只以正文为条件，否则思考阶段（无正文）整条元信息消失。
    assert.doesNotMatch(source, /footer=\{\s*(message\.)?content \?/)
  }
  assert.match(assistantPanelSource, /message\.content \|\| message\.status === 'running'/)
  assert.match(taskDetailSource, /message\.content \|\|/)
  assert.match(taskDetailSource, /message\.status === 'running' \? \(/)
  assert.match(taskDetailSource, /content \|\| running \? \(/)
  assert.match(taskDetailSource, /msg\.content \|\|/)
})

test('assistant chat renders a footer for a stopped response without visible content', () => {
  assert.match(
    assistantPanelSource,
    /message\.content \|\| message\.status === 'running' \|\| message\.status === 'stopped'/,
  )
})

test('finished footer keeps the reported usage and drops the live rate', async () => {
  const summary = await renderSummary((
    <MessageResponseFooter
      content="hello"
      usage={{ input_tokens: 100, output_tokens: 50, total_tokens: 150 }}
      engine="pydantic_ai"
      model="model-x"
      startedAt={Date.now() - 5000}
      endedAt={Date.now()}
    />
  ))
  assert.doesNotMatch(summary, /t\/s/)
  assert.match(summary, /总计 150/)
  assert.match(summary, /Pydantic AI \* model-x/)
})
