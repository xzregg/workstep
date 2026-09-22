// Must stay first so react-dom detects a DOM environment.
import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ChatInput from '../src/components/ChatInput'
import { I18nProvider } from '../src/i18n'

const quota = {
  engine_id: 'codex_sdk',
  limit_name: 'Codex',
  primary: { used_percent: 25, remaining_percent: 75 },
}

async function renderQuotaInput(
  window: ReturnType<typeof installDomEnvironment>['window'],
  onRefreshQuota: () => void,
  quotaRefreshing = false,
) {
  const container = window.document.body.appendChild(window.document.createElement('div'))
  let root!: Root
  await act(async () => {
    root = createRoot(container as never)
    root.render(
      <I18nProvider>
        <ChatInput
          value=""
          onChange={() => {}}
          onSend={() => {}}
          quota={quota}
          onRefreshQuota={onRefreshQuota}
          quotaRefreshing={quotaRefreshing}
        />
      </I18nProvider>,
    )
    await Promise.resolve()
  })
  return { container, root }
}

test('quota detail has a round refresh action that reports its loading state', async () => {
  const { window } = installDomEnvironment()
  let refreshes = 0
  try {
    const { container, root } = await renderQuotaInput(window, () => { refreshes += 1 })
    const refresh = container.querySelector('[data-quota-refresh]') as HTMLButtonElement
    assert.ok(refresh, 'quota detail should render its refresh action')
    assert.equal(refresh.disabled, false)

    await act(async () => refresh.click())
    assert.equal(refreshes, 1)

    await act(async () => {
      root.render(
        <I18nProvider>
          <ChatInput
            value=""
            onChange={() => {}}
            onSend={() => {}}
            quota={quota}
            onRefreshQuota={() => { refreshes += 1 }}
            quotaRefreshing
          />
        </I18nProvider>,
      )
      await Promise.resolve()
    })
    const loadingRefresh = container.querySelector('[data-quota-refresh]') as HTMLButtonElement
    assert.equal(loadingRefresh.disabled, true)
    assert.ok(loadingRefresh.querySelector('.task-status-spinner'))

    await act(async () => { root.unmount() })
  } finally {
    await window.happyDOM.close()
  }
})
