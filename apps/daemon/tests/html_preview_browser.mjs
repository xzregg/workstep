import assert from 'node:assert/strict'
import { isolatedHtmlDocument } from '../../web/src/utils/htmlPreviewCompat.ts'

const { chromium } = await import(process.env.WORKSTEP_PLAYWRIGHT_MODULE)
const browser = await chromium.launch({ executablePath: process.env.WORKSTEP_CHROMIUM, headless: true })
const origin = process.argv[2]
const resourceUrl = process.argv[3]
try {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-workstep-desktop-token': 'test-desktop-token' } })
  const config = JSON.parse(process.argv[5] || '{}')
  await context.addCookies(config.cookies?.length ? config.cookies : [{ name: 'viewer_session', value: 'admin', url: origin, httpOnly: true }])
  await context.route('https://unpkg.com/**', route => route.fulfill({ contentType: 'text/javascript', body: '/* deterministic CDN fixture */' }))
  await context.addInitScript(() => {
    const supports = CSS.supports.bind(CSS)
    CSS.supports = (...args) => args.includes('light-dark(white, black)') ? false : supports(...args)
  })
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()) })
  page.on('response', response => { if (response.status() >= 400) console.error(response.status(), response.url()) })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin + (config.prefix || '') + '/')
  await page.evaluate(() => localStorage.setItem('admin-secret', 'private'))
  // The parent really has privileged access: a blocked request is not merely
  // an unauthenticated test fixture accidentally returning 401.
  assert.equal((await page.request.post(origin + '/api/admin/elevate')).status(), 200)
  await page.evaluate(url => {
    const frame = document.createElement('iframe')
    frame.sandbox = 'allow-scripts allow-forms allow-popups allow-downloads'
    frame.src = url
    document.body.append(frame)
  }, origin + resourceUrl)
  const frame = page.frameLocator('iframe')
  await frame.locator('body[data-ready="42"][data-module="yes"][data-xhr="42"]').waitFor({ timeout: 5000 })
  await frame.locator('#run').click()
  assert.equal(await frame.locator('#run').textContent(), 'OK')
  assert.equal(await frame.locator('#styled').evaluate(el => getComputedStyle(el).color), 'rgb(1, 2, 3)')
  assert.equal(await frame.locator('img').evaluate(el => el.complete && el.naturalWidth > 0), true)
  assert.equal(await frame.locator('body').getAttribute('data-parent'), 'denied')
  assert.equal(await frame.locator('body').getAttribute('data-storage'), 'denied')
  await frame.frameLocator('iframe').locator('button').click()
  assert.equal(await frame.frameLocator('iframe').locator('button').textContent(), 'Nested OK')
  await frame.locator('#anchor').click()
  assert.ok((await page.locator('iframe').getAttribute('src')).includes('/html-resource/'))
  assert.equal((await page.request.get(origin + '/attempts')).ok(), true)
  assert.deepEqual(await (await page.request.get(origin + '/attempts')).json(), { writes: 1, reads: 0 })
  assert.equal(await page.evaluate(() => localStorage.getItem('admin-secret')), 'private')
  assert.deepEqual(errors, [], 'benign prototype scripts must run without JS errors')
  const sharedHtml = isolatedHtmlDocument(`<button id="shared" onclick="this.textContent='Shared OK'">Shared</button><script>
    try { parent.document.title='compromised' } catch { document.body.dataset.isolated='yes' }
    fetch('/api/admin/elevate',{method:'POST'}).catch(()=>{});
    const image = new Image(); image.src='/api/admin/read-secret';
  </script>`)
  await page.locator('iframe').evaluate((el, html) => { el.removeAttribute('src'); el.srcdoc = html }, sharedHtml)
  await frame.locator('body[data-isolated="yes"]').waitFor()
  await frame.locator('#shared').click()
  assert.equal(await frame.locator('#shared').textContent(), 'Shared OK')
  assert.deepEqual(await (await page.request.get(origin + '/attempts')).json(), { writes: 1, reads: 0 })
  // Direct raw navigation must carry the same origin isolation, with networking
  // disabled even though there is no surrounding iframe sandbox attribute.
  const raw = await context.newPage()
  await raw.goto(origin + (config.prefix || '') + '/api/fs/project-raw/' + (config.projectId || 'project-1') + '/prototype/index.html')
  assert.equal(await raw.evaluate(() => { try { return parent.localStorage.getItem('admin-secret') } catch { return 'denied' } }), 'denied')
  await raw.locator('#run').click()
  assert.equal(await raw.locator('#run').textContent(), 'OK')
  assert.deepEqual(await (await page.request.get(origin + '/attempts')).json(), { writes: 1, reads: 0 })
  const prototypes = JSON.parse(process.argv[4] || '[]')
  for (const [index, prototype] of prototypes.entries()) {
    const prototypePage = await context.newPage()
    prototypePage.setDefaultTimeout(5000)
    await prototypePage.goto(origin + (config.prefix || '') + '/')
    await prototypePage.evaluate(src => {
      const frame = document.createElement('iframe')
      frame.sandbox = 'allow-scripts allow-forms allow-popups allow-downloads'
      frame.src = src
      document.body.append(frame)
    }, origin + prototype)
    const outer = prototypePage.frameLocator('iframe')
    const design = index === 1 ? outer.frameLocator('iframe') : outer
    if (index < 2) {
      const toggle = design.locator('button[data-action="toggle"]').first()
      await toggle.waitFor()
      const before = await toggle.getAttribute('aria-pressed')
      await toggle.click()
      assert.notEqual(await toggle.getAttribute('aria-pressed'), before)
      await design.locator('button[data-action="models"]').first().click()
      await design.locator('#ws-model-dialog[open]').waitFor()
    } else if (index === 2) {
      await design.locator('#composer').fill('Sandbox prototype interaction')
      await design.locator('button#send').click()
      await design.locator('.user-bubble', { hasText: 'Sandbox prototype interaction' }).waitFor()
    } else {
      await design.locator('h1').waitFor()
      assert.ok(await design.locator('body').innerText())
    }
    await prototypePage.close()
  }
  console.log(JSON.stringify({ interaction: 'passed', css: 'passed', image: 'passed', modules: 'passed', fetch: 'passed', xhr: 'passed', identity: 'isolated', api: 'blocked', raw: 'isolated', previousPrototypes: prototypes.length }))
  await context.close()
} finally {
  await browser.close()
}
