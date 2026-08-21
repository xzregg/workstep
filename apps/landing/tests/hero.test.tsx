import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import App from '../src/App'
import { I18nProvider } from '../src/i18n'

describe('landing page', () => {
  it('temporarily hides all download entry points', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <App />
      </I18nProvider>,
    )

    expect(html).not.toContain('下载 WorkStep')
    expect(html).not.toContain('id="download"')
    expect(html).not.toMatch(/<button[^>]*>下载<\/button>/)
  })
})
