// Exercise production settings and the built manual with isolated synthetic data.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { build } from 'vite'
import { chromium } from '../../desktop/node_modules/playwright-core/index.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const artifacts = path.resolve(root, '../../tmp/settings-help')
const out = path.join(artifacts, 'browser')
const landing = path.resolve(root, '../landing/dist')
await fs.mkdir(artifacts, { recursive: true })
await build({ root, logLevel: 'error', publicDir: false, build: { outDir: out, emptyOutDir: true,
  rolldownOptions: { input: path.join(root, 'tests/fixtures/settings-help/index.html') } } })
const html = await fs.readFile(path.join(out, 'tests/fixtures/settings-help/index.html'))
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const results = []
try {
  for (const width of [320, 390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    let missing = false
    await page.context().route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.hostname !== 'help.invalid') return route.abort()
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {
        templates: [{ id: 'demo', name: '合同管理', description: '合同起草 → 法务审核 → 签署 → 归档', default: true, steps: [] }],
        providers: [], engines: [], items: [], projects: [], enabled: false,
      } })
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html })
      const isManual = url.pathname.startsWith('/landing/')
      if (isManual && missing) return route.fulfill({ status: 404, json: { detail: 'Not found' } })
      const base = isManual ? landing : out
      const relative = isManual ? url.pathname.slice('/landing/'.length) || 'index.html' : url.pathname.slice(1)
      const filename = path.resolve(base, decodeURIComponent(relative))
      if (!filename.startsWith(base + path.sep)) return route.abort()
      try {
        return route.fulfill({ body: await fs.readFile(filename), contentType: {
          '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
        }[path.extname(filename)] || 'application/octet-stream' })
      } catch { return route.fulfill({ status: 404, body: '' }) }
    })
    await page.goto('https://help.invalid/')
    const help = page.locator('h1 > .settings-help-button:visible')
    await help.waitFor()
    assert.equal(await help.count(), 1)
    const heading = await page.locator('h1:has(> .settings-help-button):visible').boundingBox()
    const icon = await help.boundingBox()
    assert.ok(Math.abs(heading.y + heading.height / 2 - icon.y - icon.height / 2) < 1)
    await page.screenshot({ path: path.join(artifacts, `title-${width}.png`) })
    await help.click()
    const reader = page.frameLocator('.manual-help-frame')
    await reader.locator('.manual-layout--embedded').waitFor()
    await page.locator('.manual-help-state').waitFor({ state: 'detached' })
    assert.match(await reader.locator('.manual-article h2').textContent(), /模板/)
    assert.equal(await reader.locator('.nav, footer, .manual-home').count(), 0)
    const panel = await page.locator('.manual-help-dialog').boundingBox()
    assert.ok(panel.x >= 0 && panel.x + panel.width <= width + 1)
    const visible = await page.locator('.manual-help-close').evaluate(el => {
      const r = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
    })
    assert.ok(visible, 'manual dialog is above settings')
    assert.equal(await reader.locator('body').evaluate(el => el.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: path.join(artifacts, `manual-${width}.png`) })
    if (width >= 1024) {
      const handle = await page.locator('.manual-help-dialog .resizable-panel-e').boundingBox()
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
      await page.mouse.down(); await page.mouse.move(handle.x - 100, handle.y + handle.height / 2); await page.mouse.up()
      assert.ok((await page.locator('.manual-help-dialog').boundingBox()).width < panel.width)
    }
    if (width <= 760) await reader.locator('.manual-directory-toggle').click()
    await reader.locator('.manual-group-links a[href="#docs/workflow"]').click()
    await reader.locator('.manual-article h2').filter({ hasText: '编辑工作流' }).waitFor()
    await page.evaluate(() => window.changeHelpLanguage())
    await reader.locator('html[lang="en-US"]').waitFor()
    await page.locator('.manual-help-state').waitFor({ state: 'detached' })
    assert.match(await page.locator('.manual-help-frame').getAttribute('src'), /#docs\/workflow$/)
    assert.equal(await reader.locator('.manual-article').count(), 1)
    const popupPromise = page.context().waitForEvent('page')
    await page.locator('.manual-help-browser').click()
    const popup = await popupPromise
    await popup.waitForURL('**/landing/?lang=en-US#docs/workflow')
    await popup.locator('.manual-article').waitFor()
    assert.equal(new URL(popup.url()).searchParams.has('embed'), false)
    assert.equal(await page.locator('.manual-help-dialog').count(), 1)
    await popup.close()
    await reader.locator('.manual-article').click()
    await page.keyboard.press('Escape')
    await page.locator('.manual-help-overlay').waitFor({ state: 'detached' })
    assert.equal(await page.locator('.settings-dialog-overlay').count(), 1)
    assert.equal(await help.evaluate(el => el === document.activeElement), true)
    // A missing manual must offer a retry instead of leaving an empty popup.
    missing = true
    await help.click()
    await page.locator('.manual-help-state').getByRole('button').waitFor({ timeout: 15000 })
    missing = false
    await page.locator('.manual-help-state').getByRole('button').click()
    await page.locator('.manual-help-state').waitFor({ state: 'detached' })
    await page.locator('.manual-help-close').click()
    assert.deepEqual(errors, [])
    results.push({ width, titleAligned: true, chapterLoaded: true, languageFollowed: true, resizeChecked: width >= 1024,
      escapePreservesSettings: true, retryRecovered: true })
    await page.close()
  }
} finally { await browser.close() }
await fs.writeFile(path.join(artifacts, 'results.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results))
