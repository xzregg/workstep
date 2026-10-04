import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ChatInputUsage from '../src/components/ChatInputUsage'
import { I18nProvider } from '../src/i18n'

test('chat usage owns quota and context details in toolbar order', async () => {
  const { window } = installDomEnvironment()
  const container = window.document.body.appendChild(window.document.createElement('div'))
  const root = createRoot(container as never)
  try {
    await act(async () => {
      root.render(<I18nProvider><ChatInputUsage
        compact={false}
        quota={{
          engine_id: 'codex_sdk',
          primary: { used_percent: 25, remaining_percent: 75 },
          secondary: { used_percent: 50, remaining_percent: 50 },
          individual_limit: { used: 2, limit: 10, remaining_percent: 80 },
        }}
        context={{ used: 250, total: 1000, percent: 25 }}
      /></I18nProvider>)
    })
    const quota = container.querySelector('.chat-input-quota') as HTMLElement
    const context = container.querySelector('.chat-input-context-breakdown-wrap') as HTMLElement
    assert.ok(quota)
    assert.ok(context)
    assert.ok(quota.compareDocumentPosition(context) & window.Node.DOCUMENT_POSITION_FOLLOWING)
    assert.match(quota.textContent || '', /75/)
    assert.match(quota.textContent || '', /50/)
    assert.match(quota.textContent || '', /80/)
    assert.equal(context.querySelector('.chat-input-context-ring-value')?.getAttribute('stroke-dasharray'), '25 100')

    await act(async () => quota.click())
    assert.ok(quota.classList.contains('is-tip-open'))
    await act(async () => context.click())
    assert.ok(context.classList.contains('is-tip-open'))
    await act(async () => window.document.body.click())
    assert.equal(quota.classList.contains('is-tip-open'), false)
    assert.equal(context.classList.contains('is-tip-open'), false)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
