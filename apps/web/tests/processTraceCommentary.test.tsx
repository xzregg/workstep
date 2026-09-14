import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ProcessTrace from '../src/components/ProcessTrace'
import MessageTimeline from '../src/components/MessageTimeline'
import { I18nProvider } from '../src/i18n'

for (const width of [390, 1280]) {
  test(`process narration is visible while running, folds on completion and can reopen at ${width}px`, async () => {
    const window = new Window({ width, url: 'http://localhost' })
    Object.assign(globalThis, {
      window, document: window.document, HTMLElement: window.HTMLElement,
      IS_REACT_ACT_ENVIRONMENT: true,
    })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const events = [
      { type: 'TEXT_MESSAGE_CHUNK', phase: 'commentary', source_item_id: 'p1', delta: '我先检查 **文件**。' },
      { type: 'TOOL_CALL_START', toolCallId: 'read', toolCallName: 'Read' },
      { type: 'TOOL_CALL_RESULT', toolCallId: 'read', output: 'ok' },
      { type: 'TEXT_MESSAGE_CHUNK', phase: 'commentary', source_item_id: 'p2', delta: '正在核对。' },
    ]
    const render = (running: boolean, answerStarted = false) => {
      const visibleEvents = answerStarted
        ? [...events, { type: 'TEXT_MESSAGE_CHUNK', phase: 'final_answer', source_item_id: 'answer', delta: '已完成。' }]
        : events
      root.render(
      <I18nProvider>
        <ProcessTrace events={visibleEvents} running={running} />
        <MessageTimeline content={running && !answerStarted ? '' : '已完成。'} streaming={running} events={visibleEvents} />
      </I18nProvider>,
      )
    }
    try {
      await act(async () => render(true))
      let trace = container.querySelector<HTMLDivElement>('.process-trace-session')!
      assert.equal(trace.dataset.open, 'true')
      assert.match(trace.textContent ?? '', /我先检查 文件。/)
      assert.equal(trace.querySelector('strong')?.textContent, '文件')
      const items = trace.querySelector('.process-trace-body')!.children
      assert.match(items[0].textContent ?? '', /我先检查/)
      assert.ok(items[1].classList.contains('llm-tool-call'))
      assert.match(items[2].textContent ?? '', /正在核对/)
      assert.equal(container.querySelectorAll('.markdown-stream-cursor').length, 1,
        'only the active process paragraph has a cursor before the final answer starts')

      await act(async () => render(true, true))
      assert.equal(trace.querySelectorAll('.markdown-stream-cursor').length, 0)
      assert.equal(container.querySelectorAll('.markdown-stream-cursor').length, 1)

      await act(async () => render(false))
      trace = container.querySelector<HTMLDivElement>('.process-trace-session')!
      assert.equal(trace.dataset.open, undefined)
      assert.doesNotMatch(trace.textContent ?? '', /已完成/)
      assert.match(container.textContent ?? '', /已完成/)
      await act(async () => {
        trace.querySelector<HTMLDivElement>('.process-trace-session-summary')!
          .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(trace.dataset.open, 'true')
      await act(async () => render(false))
      assert.equal(trace.dataset.open, 'true', 'unrelated rerenders preserve manual expansion')
    } finally {
      await act(async () => root.unmount())
      await window.happyDOM.close()
    }
  })
}

test('unloaded process details do not show an expand-to-load placeholder', async () => {
  const window = new Window({ width: 1280, url: 'http://localhost' })
  Object.assign(globalThis, {
    window, document: window.document, HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let loadCount = 0
  try {
    await act(async () => root.render(
      <I18nProvider>
        <ProcessTrace
          events={[]}
          detailsAvailable
          onLoadDetails={() => { loadCount += 1 }}
        />
      </I18nProvider>,
    ))
    const session = container.querySelector<HTMLDivElement>('.process-trace-session')!
    assert.ok(session)
    await act(async () => {
      container.querySelector<HTMLDivElement>('.process-trace-session-summary')!
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    assert.ok(loadCount >= 1)
    assert.doesNotMatch(session.textContent ?? '', /展开后加载详细过程/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
