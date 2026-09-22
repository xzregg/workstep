import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import FloatingMenu from '../src/components/FloatingMenu'
import { I18nProvider } from '../src/i18n'

test('floating menu ignores unrelated message-list scrolls but closes when its anchor scrolls', async () => {
  const window = new Window({ width: 1280, url: 'http://localhost/chat' })
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })

  const rootElement = document.body.appendChild(document.createElement('div'))
  const root = createRoot(rootElement)
  const triggerRef = createRef<HTMLButtonElement>()
  let closeCount = 0

  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <div data-testid="composer-scroll-container">
            <button ref={triggerRef}>权限</button>
          </div>
          <div data-testid="message-list" />
          <FloatingMenu
            anchor={{ left: 100, top: 500, width: 80, height: 30 }}
            options={[{ value: 'ask', label: '需要批准' }]}
            value="ask"
            onSelect={() => {}}
            onClose={() => { closeCount += 1 }}
            triggerRef={triggerRef}
          />
        </I18nProvider>,
      )
    })

    const messageList = document.querySelector('[data-testid="message-list"]')!
    messageList.dispatchEvent(new window.Event('scroll'))
    assert.equal(closeCount, 0)

    const composerScroller = document.querySelector('[data-testid="composer-scroll-container"]')!
    composerScroller.dispatchEvent(new window.Event('scroll'))
    assert.equal(closeCount, 1)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
