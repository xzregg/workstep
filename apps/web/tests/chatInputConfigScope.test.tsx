import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ChatInput from '../src/components/ChatInput'
import { I18nProvider } from '../src/i18n'

for (const width of [320, 390, 1023, 1280]) test(`configuration reopening stays within its conversation at ${width}px`, async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width, height: 844 })
  Object.assign(globalThis, { history: window.history })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const render = async (sessionId: string, reopenSignal: number, key = 'same') => {
    await act(async () => {
      root.render(<I18nProvider><ChatInput key={key} sessionId={sessionId} projectId="project"
        value="" onChange={() => {}} onSend={() => {}}
        config={{ engines: [], engine: '', defaultEngine: '', model: '', fastModel: '', reopenSignal,
          onEngineChange: () => {}, onModelChange: () => {}, onFastModelChange: () => {} }}
      /></I18nProvider>)
    })
  }
  const isOpen = () => container.querySelector('.chat-input-config-anchor > button')?.getAttribute('aria-expanded') === 'true'
  try {
    await render('session-a', 1)
    assert.equal(isOpen(), false, 'a previously handled reopen event must not open a new composer')
    await render('session-a', 2)
    assert.equal(isOpen(), true, 'a new handoff completion can reopen the current configuration')
    assert.equal(document.querySelectorAll('.mobile-sheet').length, width <= 1023 ? 1 : 0)
    await render('session-b', 2)
    assert.equal(isOpen(), false, 'changing conversation closes configuration')
    assert.ok(document.querySelector('.mobile-sheet') === null)
    await render('session-b', 3)
    assert.equal(isOpen(), true)
    await render('session-c', 3, 'remount')
    assert.equal(isOpen(), false, 'remounting must not replay an old handoff completion')
    assert.ok(document.querySelector('.mobile-sheet') === null)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
