import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { AppRoutes } from '../src/App'
import { I18nProvider } from '../src/i18n'

test('Git route renders its page on the first navigation frame', async () => {
  const { window } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('{}', { status: 503 })
  try {
    flushSync(() => root.render(
      <I18nProvider>
        <MemoryRouter initialEntries={['/git?project_id=p']}>
          <AppRoutes />
        </MemoryRouter>
      </I18nProvider>,
    ))
    assert.ok(host.querySelector('.git-page-header') !== null)
  } finally {
    await act(async () => root.unmount())
    host.remove()
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})
