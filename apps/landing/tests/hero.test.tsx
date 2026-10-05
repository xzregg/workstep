import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import App from '../src/App'
import { I18nProvider } from '../src/i18n'
import { getExperienceHref } from '../src/config/entryPoints'
import { Hero } from '../src/components/Hero'
import { FinalCta } from '../src/components/FinalCta'
import { RELEASES_URL } from '../src/config/downloads'

describe('landing page', () => {
  it('links downloads to GitHub releases with a compact label', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <App />
      </I18nProvider>,
    )

    expect(html).toContain(`href="${RELEASES_URL}"`)
    expect(html).toMatch(/class="nav-control nav-download"[^>]*>下载<\/a>/)
  })

  it.each(['/landing', '/landing/', '/landing/index.html'])('returns to the web app from %s', (path) => {
    expect(getExperienceHref(path)).toBe('/')
  })

  it.each(['/', '/workstep/', '/index.html', '/landing-other'])('launches the desktop app from the standalone site at %s', (path) => {
    expect(getExperienceHref(path)).toBe('workstep://open')
  })

  it.each(['/', 'workstep://open'])('uses the same experience destination in both calls to action: %s', (href) => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <Hero onOpenDemos={() => undefined} experienceHref={href} />
        <FinalCta experienceHref={href} />
      </I18nProvider>,
    )
    expect(html.split(`href="${href}"`)).toHaveLength(3)
  })
})
