import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import App from '../src/App'
import { I18nProvider, translate } from '../src/i18n'

describe('focused homepage and extensible engines', () => {
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
