import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { AppRoutes } from '../src/App'
import { I18nProvider } from '../src/i18n'

test('Git route renders its page on the first navigation frame', async () => {
  const { window } = installDomEnvironment()
  try {
    const html = renderToString(
      <I18nProvider>
        <MemoryRouter initialEntries={['/git?project_id=p']}>
          <AppRoutes />
        </MemoryRouter>
      </I18nProvider>,
    )
    assert.match(html, /class="git-page-header"/)
  } finally {
    await window.happyDOM.close()
  }
})
