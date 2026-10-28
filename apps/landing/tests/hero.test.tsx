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

  it('explains the development outcome and setup requirements in the hero', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <Hero onOpenDemos={() => undefined} experienceHref="/" />
      </I18nProvider>,
    )

    expect(html).toContain('从一个需求，')
    expect(html).toContain('走到一份交付。')
    expect(html).toContain('首次使用需安装一个执行引擎并完成认证')
    expect(html).toContain('模型服务费用')
    expect(html).toContain('href="#start"')
    expect(html).not.toContain('聊聊天就能跑起来')
  })

  it.each(['/landing', '/landing/', '/landing/index.html'])('returns to the web app from %s', (path) => {
    expect(getExperienceHref(path)).toBe('/')
  })

  it.each(['/', '/workstep/', '/index.html', '/landing-other'])('offers a download to first-time visitors at %s', (path) => {
    expect(getExperienceHref(path)).toBe(RELEASES_URL)
  })

  it.each([
    ['/', '打开工作台'],
    [RELEASES_URL, '下载桌面版'],
  ])('uses matching destinations and labels in both calls to action: %s', (href, label) => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <Hero onOpenDemos={() => undefined} experienceHref={href} />
        <FinalCta experienceHref={href} />
      </I18nProvider>,
    )
    expect(html.split(`href="${href}"`)).toHaveLength(3)
    expect(html.split(`${label}<`)).toHaveLength(3)
    expect(html).not.toContain('立即体验')
  })
})
