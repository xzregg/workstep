import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'
import { I18nProvider, supportedLanguages } from '../src/i18n'
import { editorialCopy } from '../src/i18n/editorial'
import { legalCopy } from '../src/i18n/legal'

afterEach(() => vi.unstubAllGlobals())
function render(hash = '', lang = 'en-US') {
  vi.stubGlobal('window', { location: { hash, pathname: '/workstep/' }, localStorage: { getItem: () => lang }, navigator: { language: lang }, matchMedia: () => ({ matches: false }) })
  return renderToStaticMarkup(<I18nProvider><App /></I18nProvider>)
}
describe('public information without pricing promises or personal attribution', () => {
  it('keeps terms, support and the license but removes free-pricing entries', () => {
    const html = render()
    expect(html).toContain('href="mailto:xzregg@gmail.com"')
    expect(html).toContain('Apache License 2.0')
    expect(html).toContain('href="#terms"')
    expect(html).not.toContain('href="#pricing"')
    expect(html).not.toContain('Free and open source')
    expect(html).not.toContain('No paid WorkStep subscription')
    expect(html).not.toContain('¥0')
  })
  it('serves terms without personal attribution or a pricing promise', () => {
    const html = render('#terms')
    expect(html).toContain('Terms of Use')
    expect(html).not.toContain('independent developer')
    expect(html).not.toContain('id="intro-title"')
  })
  for (const { locale } of supportedLanguages) {
    it(`renders ${locale} terms with real translated content`, () => {
      const html = render('#terms', locale)
      expect(html).toContain(legalCopy[locale].title)
      expect(html).toContain('Apache License 2.0')
      expect(html).not.toContain('No paid WorkStep subscription')
      if (locale !== 'en-US') expect(legalCopy[locale].warranty).not.toBe(legalCopy['en-US'].warranty)
    })
    it(`uses actual ${locale} privacy copy without a checkout or fee claim`, () => {
      const html = render('#privacy', locale)
      expect(html).toContain('Cloudflare Web Analytics')
      expect(html).toContain('href="mailto:xzregg@gmail.com"')
      expect(html).not.toContain('Creem')
      expect(html).not.toContain('independent developer')
      expect(editorialCopy[locale].supportNotice.length).toBeGreaterThan(20)
      if (locale !== 'zh-CN') expect(editorialCopy[locale].supportNotice).not.toBe(editorialCopy['zh-CN'].supportNotice)
    })
  }
})
