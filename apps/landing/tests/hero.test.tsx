import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import App from '../src/App'
import { I18nProvider } from '../src/i18n'

describe('landing page', () => {
  it('offers the desktop app launcher and a download fallback', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <App />
      </I18nProvider>,
    )

    expect(html).toContain('href="workstep://open"')

  })
})
