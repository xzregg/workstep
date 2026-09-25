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

test('manual review renders the green set-complete action beside its badge', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  let completed = 0
  try {
    await act(async () => root.render(
      <I18nProvider>
        <MessageMetaBar
          reviewMode
          reviewStatus="terminated"
          onViewPrompt={() => undefined}
          onSetReviewComplete={() => { completed += 1 }}
        />
      </I18nProvider>,
    ))
    const button = [...window.document.querySelectorAll('button')]
      .find((item) => item.textContent?.trim() === '设置完成') as HTMLButtonElement | undefined
    assert.ok(button)
    assert.equal(button.style.color, 'var(--success)')
    await act(async () => button.click())
    assert.equal(completed, 1)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('stopped automatic review can show the same set-complete action', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  let completed = 0
  try {
    await act(async () => root.render(
      <I18nProvider>
        <MessageMetaBar
          status="cancelled"
          onViewPrompt={() => undefined}
          onSetReviewComplete={() => { completed += 1 }}
        />
      </I18nProvider>,
    ))
    const button = [...window.document.querySelectorAll('button')]
      .find((item) => item.textContent?.trim() === '设置完成') as HTMLButtonElement | undefined
    assert.ok(button)
    const summary = button.closest('.process-trace-session-summary')
    assert.ok(summary)
    const rightMeta = summary.querySelector('.message-meta-details')
    assert.ok(rightMeta)
    assert.equal(button.parentElement, summary)
    assert.ok([...summary.children].indexOf(button) < [...summary.children].indexOf(rightMeta))
    await act(async () => button.click())
    assert.equal(completed, 1)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('failed execution can show restart and set-complete together', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  let retried = 0
  let completed = 0
  try {
    await act(async () => root.render(
      <I18nProvider>
        <MessageMetaBar
          status="failed"
          onViewPrompt={() => undefined}
          onRetryFailedMessage={() => { retried += 1 }}
          onSetReviewComplete={() => { completed += 1 }}
        />
      </I18nProvider>,
    ))
    const restart = window.document.querySelector('button[title="重启失败的消息"]') as HTMLButtonElement | null
    const complete = [...window.document.querySelectorAll('button')]
      .find((item) => item.textContent?.trim() === '设置完成') as HTMLButtonElement | undefined
    assert.ok(restart)
    assert.ok(complete)
    await act(async () => restart.click())
    await act(async () => complete.click())
    assert.equal(retried, 1)
    assert.equal(completed, 1)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('stopped execution can show restart and set-complete together', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  let restarted = 0
  let completed = 0
  try {
    await act(async () => root.render(
      <I18nProvider>
        <MessageMetaBar
          status="stopped"
          onViewPrompt={() => undefined}
          onRestartStoppedMessage={() => { restarted += 1 }}
          onSetReviewComplete={() => { completed += 1 }}
        />
      </I18nProvider>,
    ))
    const restart = window.document.querySelector('button[title="用新会话重跑"]') as HTMLButtonElement | null
    const complete = [...window.document.querySelectorAll('button')]
      .find((item) => item.textContent?.trim() === '设置完成') as HTMLButtonElement | undefined
    assert.ok(restart)
    assert.ok(complete)
    await act(async () => restart.click())
    await act(async () => complete.click())
    assert.equal(restarted, 1)
    assert.equal(completed, 1)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
