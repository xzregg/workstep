// Must stay first so react-dom detects a DOM environment.
import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { useState } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ChatInput from '../src/components/ChatInput'
import { I18nProvider } from '../src/i18n'

function Harness({ coordinator = false }: { coordinator?: boolean }) {
  const [active, setActive] = useState(false)
  return (
    <I18nProvider>
      <ChatInput
        value=""
        onChange={() => {}}
        onSend={() => {}}
        imageAttach={{ projectId: 'project-1' }}
        resetStep={{
          active,
          onChange: setActive,
          ...(coordinator ? { label: 'Reset session', title: 'Start a fresh coordinator session' } : {}),
        }}
      />
    </I18nProvider>
  )
}

test('reset-step toggle sits after the plus button and exposes its selected state', async () => {
  const { window } = installDomEnvironment()
  const container = window.document.body.appendChild(window.document.createElement('div'))
  const root = createRoot(container as never)
  try {
    await act(async () => root.render(<Harness />))

    const attach = container.querySelector('.chat-input-attach') as HTMLButtonElement
    const toggle = container.querySelector('[data-reset-step]') as HTMLButtonElement
    assert.ok(attach)
    assert.ok(toggle)
    assert.equal(attach.parentElement?.nextElementSibling, toggle)
    assert.equal(toggle.getAttribute('aria-pressed'), 'false')
    assert.equal(toggle.getAttribute('data-active'), 'false')
    assert.equal(toggle.textContent?.trim(), 'Reset step')
    assert.ok(toggle.querySelector('.lucide-radio'))

    await act(async () => toggle.click())
    assert.equal(toggle.getAttribute('aria-pressed'), 'true')
    assert.equal(toggle.getAttribute('data-active'), 'true')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('coordinator reset uses a session label and keeps the same one-shot toggle behavior', async () => {
  const { window } = installDomEnvironment()
  const container = window.document.body.appendChild(window.document.createElement('div'))
  const root = createRoot(container as never)
  try {
    await act(async () => root.render(<Harness coordinator />))
    const toggle = container.querySelector('[data-reset-step]') as HTMLButtonElement
    assert.equal(toggle.textContent?.trim(), 'Reset session')
    assert.equal(toggle.title, 'Start a fresh coordinator session')
    await act(async () => toggle.click())
    assert.equal(toggle.getAttribute('aria-pressed'), 'true')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
