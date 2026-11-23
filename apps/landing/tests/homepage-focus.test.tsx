import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import App from '../src/App'
import { I18nProvider, translate } from '../src/i18n'

describe('focused homepage and extensible engines', () => {
  it('shows the introduction video below the hero and keeps engine setup near tutorials', () => {
    const html = renderToStaticMarkup(<I18nProvider><App /></I18nProvider>)
    expect(html).not.toContain('id="philosophy"')
    expect(html.indexOf('id="engines"')).toBeLessThan(html.indexOf('id="start"'))
    for (const content of ['class="guided-walkthrough"', 'class="start-layout"', 'class="compare-table"']) {
      expect(html).toContain(content)
    }
    expect(html).not.toContain('product-intro-optional')
    expect(html).toContain('id="product-intro-title"')
    expect(html).toContain('class="product-intro-player"')
    expect(html.indexOf('id="intro-video"')).toBeLessThan(html.indexOf('id="mechanisms"'))
    expect(html.match(/class="workflow-card"/g)).toHaveLength(4)
    const walkthrough = html.match(/<section class="guided-walkthrough"[\s\S]*?<\/section>/)?.[0]
    expect(walkthrough).not.toContain('从一个能检查结果的小任务开始')
    expect(walkthrough).not.toContain('安装桌面版，配置并验证一个执行引擎')
    expect(walkthrough).toContain('<h2 class="section-title walkthrough-title">从流程到任务，跟着实际操作走一遍</h2>')
    expect(walkthrough).not.toContain('id="download"')
    expect(html).not.toContain('class="final-cta"')
    expect(html).toContain('id="download"')
    const startHeading = html.slice(html.indexOf('id="start"'), html.indexOf('class="start-routes"'))
    expect(startHeading).not.toContain('首次使用需安装一个执行引擎并完成认证')
    expect(html).not.toContain('<section class="final-cta"')
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
