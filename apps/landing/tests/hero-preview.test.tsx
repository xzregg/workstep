import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HeroPreview } from '../src/components/HeroPreview'
import { I18nProvider } from '../src/i18n'

describe('HeroPreview', () => {
  it('shows a left-aligned add-project action without the live ticker', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <HeroPreview />
      </I18nProvider>,
    )

    expect(html).toContain('添加项目')
    expect(html).not.toContain('hero-ticker')
    expect(html).not.toContain('实时流')

    const styles = readFileSync(
      fileURLToPath(new URL('../src/landing.css', import.meta.url)),
      'utf8',
    )
    expect(styles).toMatch(/\.side-add\s*\{[^}]*justify-content:\s*flex-start;/s)
    expect(styles).toMatch(/\.hero-app\s*\{[^}]*min-height:\s*460px;/s)
  })
})
