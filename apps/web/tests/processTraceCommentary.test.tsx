import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ProcessTrace from '../src/components/ProcessTrace'
import { I18nProvider } from '../src/i18n'

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
