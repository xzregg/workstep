import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import MessageResponseFooter from '../src/components/MessageResponseFooter'
import ProcessTrace from '../src/components/ProcessTrace'
import { I18nProvider, useLocaleStore } from '../src/i18n'

test('footer and thinking share live speed; completion and refresh preserve it without usage/elapsed fallback', async (context) => {
  const { window, document } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const start = Date.parse('2026-11-08T00:00:00Z')
  let now = start + 2000
  context.mock.method(Date, 'now', () => now)
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const events = [
    { type: 'TEXT_MESSAGE_CHUNK', delta: 'first', timestamp: start },
    { type: 'REASONING_MESSAGE_CHUNK', delta: '中文中文', timestamp: start + 1000 },
    { type: 'REASONING_MESSAGE_CHUNK', delta: 'abcdefgh', timestamp: start + 2000 },
  ]
  const render = (running: boolean, items = events, summary?: Record<string, unknown>) => root.render(
    <I18nProvider>
      <MessageResponseFooter content="" running={running} events={items} eventSummary={summary}
        startedAt={start - 300000} usage={{ input_tokens: 200000, output_tokens: 670 }} />
      <ProcessTrace running={running} events={items} />
    </I18nProvider>,
  )
  try {
    await act(async () => render(true))
    await act(async () => container.querySelector<HTMLElement>('.process-trace-session-summary')!.click())
    assert.equal((container.textContent!.match(/3 t\/s/g) ?? []).length, 2)
    const tools = [...events, { type: 'TOOL_CALL_RESULT', timestamp: start + 3000 }]
    now = start + 3000
    await act(async () => render(true, tools))
    assert.match(container.textContent!, /3 t\/s/)
    now = start + 300000
    await act(async () => render(true, []))
    assert.match(container.textContent!, /3 t\/s/, 'event trimming must not erase the retained rate')
    await act(async () => render(false, tools))
    assert.match(container.textContent!, /3 t\/s/)
    // Remount simulates a page refresh that receives only the compact summary.
    await act(async () => root.render(null))
    await act(async () => render(false, [], { output_rate_sample: { units: 24, elapsed_ms: 2000 }, elapsed_ms: 300000 }))
    assert.match(container.textContent!, /3 t\/s/)
    await act(async () => root.render(null))
    await act(async () => render(true, [], { output_rate_sample: { units: 24, elapsed_ms: 2000 } }))
    assert.match(container.textContent!, /3 t\/s/, 'running history restores the last measured rate too')
    await act(async () => root.render(null))
    await act(async () => render(false, [], { elapsed_ms: 300000 }))
    assert.doesNotMatch(container.textContent!, /t\/s/)
  } finally {
    await act(async () => root.unmount())
    context.mock.restoreAll()
    await window.happyDOM.close()
  }
})
