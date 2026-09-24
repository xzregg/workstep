import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import MessageMetaBar from '../src/components/MessageMetaBar'
import { I18nProvider } from '../src/i18n'
import { installDomEnvironment } from './helpers/domEnv'

test('failed execution message shows a retry action beside its failure badge', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  let retried = 0
  try {
    await act(async () => root.render(
      <I18nProvider>
        <MessageMetaBar
          status="failed"
          messageId="failed-message"
          onViewPrompt={() => undefined}
          onRetryFailedMessage={() => { retried += 1 }}
        />
      </I18nProvider>,
    ))
    const retry = window.document.querySelector('button[title="重启失败的消息"]') as HTMLButtonElement | null
    assert.ok(retry)
    assert.equal(retry.textContent?.trim(), '重启')
    await act(async () => retry.click())
    assert.equal(retried, 1)
    await act(async () => root.render(
      <I18nProvider>
        <MessageMetaBar
          status="failed"
          messageId="failed-message"
          onViewPrompt={() => undefined}
          onRetryFailedMessage={() => { retried += 1 }}
          retryingFailedMessage
        />
      </I18nProvider>,
    ))
    assert.equal((window.document.querySelector('button[title="重启失败的消息"]') as HTMLButtonElement).disabled, true)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('retry action stays hidden for completed and read-only messages', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  try {
    await act(async () => root.render(
      <I18nProvider>
        <MessageMetaBar status="failed" onViewPrompt={() => undefined} />
      </I18nProvider>,
    ))
    assert.equal(window.document.querySelector('button[title="重启失败的消息"]'), null)
    await act(async () => root.render(
      <I18nProvider>
        <MessageMetaBar onViewPrompt={() => undefined} onRetryFailedMessage={() => undefined} />
      </I18nProvider>,
    ))
    assert.equal(window.document.querySelector('button[title="重启失败的消息"]'), null)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
