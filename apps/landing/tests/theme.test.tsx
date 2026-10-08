import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Nav } from '../src/components/Nav'
import { I18nProvider } from '../src/i18n'
import { nextTheme, resolveTheme } from '../src/theme'

describe('landing theme', () => {
  it('uses a saved preference before the operating-system preference', () => {
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme(null, true)).toBe('dark')
    expect(resolveTheme(null, false)).toBe('light')
  })

  it('switches between light and dark themes', () => {
    expect(nextTheme('light')).toBe('dark')
    expect(nextTheme('dark')).toBe('light')
  })

  it('renders an accessible theme control in the navigation', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <Nav />
      </I18nProvider>,
    )

    expect(html).toMatch(/class="[^"]*nav-theme[^"]*"/)
    expect(html).toContain('aria-label="切换到夜间模式"')
    expect(html.match(/class="[^"]*nav-control[^"]*"/g)).toHaveLength(4)
  })
})
