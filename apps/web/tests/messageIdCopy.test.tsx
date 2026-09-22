import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import MessageIdPopover from '../src/components/MessageIdPopover'
import { I18nProvider } from '../src/i18n'

test('copying the message id also copies its session id', async () => {
  const window = new Window({ width: 1280, url: 'http://localhost' })
  const copied: string[] = []
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value: string) => { copied.push(value) } },
  })
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)

  try {
    await act(async () => root.render(
      <I18nProvider>
        <MessageIdPopover sessionId="session-123" messageId="message-456" />
      </I18nProvider>,
    ))
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-haspopup="true"]')!.click()
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="复制消息 ID"]')!.click()
    })

    assert.deepEqual(copied, ['会话 ID: session-123\n消息 ID: message-456'])
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
