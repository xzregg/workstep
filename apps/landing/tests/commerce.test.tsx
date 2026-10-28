import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'
import { I18nProvider } from '../src/i18n'

afterEach(() => vi.unstubAllGlobals())

function render(hash = '', lang = 'en-US') {
  vi.stubGlobal('window', {
    location: { hash, pathname: '/workstep/' },
    localStorage: { getItem: () => lang }, navigator: { language: lang },
  })
  return renderToStaticMarkup(<I18nProvider><App /></I18nProvider>)
}

describe('public pricing, support and legal information', () => {
  it('shows the free price, external AI costs and a reachable support address', () => {
    const html = render()
    expect(html).toContain('Free and open source')
    expect(html).toContain('Third-party model services are billed separately')
    expect(html).toContain('href="mailto:xzregg@gmail.com"')
    expect(html).toContain('href="#terms"')
    expect(html).toContain('href="#pricing"')
  })

  it('opens the terms as a standalone route and states the actual license and limitations', () => {
    const html = render('#terms')
    expect(html).toContain('Terms of Use')
    expect(html).toContain('Apache License 2.0')
    expect(html).toContain('No paid WorkStep subscription')
    expect(html).toContain('early-access')
    expect(html).not.toContain('id="demos"')
    expect(html).toContain('href="#privacy"')
    expect(html).toContain('WorkStep 是本地优先的 AI 研发工作台。')
    expect(html).toContain('WorkStep is a local-first AI development workspace.')
    expect(html).not.toContain('maintained by independent developer')
  })

  it('explains support correspondence and Creem data processing on the privacy route', () => {
    const html = render('#privacy')
    expect(html).toContain('Creem')
    expect(html).toContain('support correspondence')
    expect(html).toContain('href="mailto:xzregg@gmail.com"')
    expect(html).toContain('Cloudflare Web Analytics')
  })
})
