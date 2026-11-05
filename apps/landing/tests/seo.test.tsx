import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderHomepage } from '../src/prerender'
import { prerenderDocument } from '../scripts/prerender.mjs'

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

describe('public website SEO', () => {
  it('identifies the official site and supplies link previews without JavaScript', () => {
    const html = read('../index.html')
    expect(html).toContain('<link rel="canonical" href="https://workstep.me/"')
    for (const property of ['og:type', 'og:url', 'og:site_name', 'og:image', 'og:image:alt', 'og:locale']) {
      expect(html).toContain(`property="${property}"`)
    }
    expect(html).toContain('name="twitter:card" content="summary_large_image"')
    expect(html).toContain('name="twitter:image"')
    expect(html).toContain('https://workstep.me/og-image.jpg')
    const schema = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1])
    expect(schema['@type']).toBe('SoftwareApplication')
    expect(schema.url).toBe('https://workstep.me/')
    expect(schema.sameAs).toBe('https://github.com/xzregg/workstep')
    expect(schema).not.toHaveProperty('aggregateRating')
    expect(schema).not.toHaveProperty('offers')
  })

  it('gives crawlers the real homepage content before the browser app starts', () => {
    const html = renderHomepage()
    expect(html).toContain('<main')
    expect(html.match(/<h1\b/g)).toHaveLength(1)
    expect(html).toContain('让 AI 按步骤开发，')
    expect(html).toContain('关键结果由你把关')
    expect(html).toContain('href="https://github.com/xzregg/workstep/releases/latest"')
    expect(html).toContain('首次使用需安装一个执行引擎并完成认证')
  })

  it.each(['./assets/', '/assets/', '/workstep/assets/', '/landing/assets/'])(
    'keeps static images on the client build asset path %s', (base) => {
      const html = `<html><head><script type="module" src="${base}index.js"></script></head><body><div id="root"></div></body></html>`
      const output = prerenderDocument(html, '<main><h1>WorkStep</h1><video poster="/assets/cover.jpg"></video><img src="/assets/setup.jpg" /></main>')
      expect(output).toContain(`poster="${base}cover.jpg"`)
      expect(output).toContain(`src="${base}setup.jpg"`)
      expect(output).not.toContain('<div id="root"></div>')
    },
  )

  it('only lists independently crawlable URLs, not hash routes or invented language pages', () => {
    expect(read('../public/robots.txt')).toContain('Sitemap: https://workstep.me/sitemap.xml')
    const sitemap = read('../public/sitemap.xml')
    expect(sitemap).toContain('<loc>https://workstep.me/</loc>')
    expect(sitemap).not.toContain('#')
    expect(sitemap).not.toContain('lastmod')
    expect(readFileSync(new URL('../public/og-image.jpg', import.meta.url)).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
  })
})
