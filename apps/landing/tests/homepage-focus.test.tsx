import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'
import { Hero } from '../src/components/Hero'
import { EnginesStrip } from '../src/components/EnginesStrip'
import { I18nProvider, supportedLanguages, translate } from '../src/i18n'

afterEach(() => vi.unstubAllGlobals())

describe('focused homepage and extensible engines', () => {
  it.each(supportedLanguages.map(({ locale }) => locale))('makes engine extension discoverable in %s', locale => {
    vi.stubGlobal('window', { localStorage: { getItem: () => locale }, navigator: { language: locale } })
    const html = renderToStaticMarkup(<I18nProvider><Hero onOpenDemos={() => undefined} experienceHref="/" /><EnginesStrip /></I18nProvider>)
    expect(html).toContain('href="#engines"')
    expect(html).toContain('href="#docs/custom-engines"')
    expect(html).not.toContain('docs/llm-engine-development-guide.md')
    expect(translate(locale, 'engines.extension')).not.toBe('engines.extension')
    expect(html).toContain(translate(locale, 'engines.extension'))
    expect(html).toContain('CLI')
    expect(html).toContain('SDK')
    expect(html).toContain('ACP')
  })

  it('keeps the example and engine choice before optional tutorials and comparisons', () => {
    const html = renderToStaticMarkup(<I18nProvider><App /></I18nProvider>)
    expect(html.indexOf('id="philosophy"')).toBeLessThan(html.indexOf('id="engines"'))
    expect(html.indexOf('id="engines"')).toBeLessThan(html.indexOf('id="start"'))
    for (const content of ['class="guided-walkthrough"', 'class="start-layout"', 'class="compare-table"']) {
      expect(html).toContain(content)
    }
    expect(html).not.toContain('<details')
    expect(html).not.toContain('<summary')
    expect(html.match(/class="workflow-card"/g)).toHaveLength(4)
  })

  it('keeps search and social descriptions aligned with visible engine extensibility', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    expect(translate('zh-CN', 'meta.title')).toContain('自定义 Agent 引擎')
    expect(html).toContain(`<title>${translate('zh-CN', 'meta.title')}</title>`)
    expect(html).toContain(`content="${translate('zh-CN', 'meta.description')}"`)
    const schema = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1])
    expect(schema.description).toBe(translate('zh-CN', 'meta.description'))
  })
})
