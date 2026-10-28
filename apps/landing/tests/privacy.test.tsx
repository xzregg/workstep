import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider, supportedLanguages, translate } from '../src/i18n'
import { PrivacyPage } from '../src/components/PrivacyPage'

afterEach(() => vi.unstubAllGlobals())

describe('localized privacy notice', () => {
  for (const lang of supportedLanguages.map(item => item.locale)) {
    it(`renders the ${lang} notice with the shared site preference`, () => {
      vi.stubGlobal('window', {
        localStorage: { getItem: () => lang }, navigator: { language: 'en-US' },
      })
      const html = renderToStaticMarkup(<I18nProvider><PrivacyPage /></I18nProvider>)
      expect(html).toContain(translate(lang, 'privacy.title'))
      expect(html).toContain('Cloudflare Web Analytics')
      expect(html).toContain('href="#top"')
    })
  }

  it('keeps the site usable when browser storage is unavailable', () => {
    vi.stubGlobal('window', {
      get localStorage() { throw new Error('Blocked storage') }, navigator: { language: 'de-DE' },
    })
    const html = renderToStaticMarkup(<I18nProvider><PrivacyPage /></I18nProvider>)
    expect(html).toContain(translate('de-DE', 'privacy.title'))
  })
})
