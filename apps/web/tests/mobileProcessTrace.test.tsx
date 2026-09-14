import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ProcessTrace from '../src/components/ProcessTrace'
import { I18nProvider } from '../src/i18n'

for (const width of [390, 1280]) {
  test(`completed process disclosure defaults to closed at ${width}px and remains expandable`, async () => {
    const window = new Window({ width })
    Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root.render(<I18nProvider><ProcessTrace events={[{ type: 'thinking_delta', data: { delta: '检查任务' } }]} /></I18nProvider>))
    const session = document.querySelector<HTMLDivElement>('.process-trace-session')!
    assert.ok(session)
    // 默认折叠：data-open 未设置，body 完全不渲染（巨型 trace 不占 DOM）
    assert.equal(session.dataset.open, undefined)
    assert.equal(document.querySelector('.process-trace-body'), null)
    const summary = document.querySelector<HTMLDivElement>('.process-trace-session-summary')!
    await act(async () => { summary.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    assert.equal(session.dataset.open, 'true')
    assert.match(document.querySelector('.process-trace-body')!.textContent!, /检查任务/)
    await act(async () => root.unmount())
    await window.happyDOM.close()
  })
}
