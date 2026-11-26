import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { build } from 'vite'
import { chromium } from '../../desktop/node_modules/playwright-core/index.mjs'

const root = path.resolve(import.meta.dirname, '..')
const output = path.resolve(root, '../../tmp/engine-login/browser')
await fs.mkdir(output, { recursive:true })
await build({ root, logLevel:'error', publicDir:false, build:{outDir:output,emptyOutDir:true,
  rolldownOptions:{input:path.join(root,'tests/fixtures/engine-login/index.html')} } })
const browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
const results = []
try {
  for (const width of [320,390,1024,1440]) {
    const page = await browser.newPage({viewport:{width,height:900}})
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('https://login.invalid/**', async route => {
      const pathname = new URL(route.request().url()).pathname
      if (pathname.startsWith('/api/')) return route.fulfill({json:{}})
      const file = pathname === '/' ? path.join(output,'tests/fixtures/engine-login/index.html') : path.join(output, pathname)
      try { return route.fulfill({body:await fs.readFile(file),contentType:pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':'text/html'}) }
      catch { return route.fulfill({status:404}) }
    })
    await page.goto('https://login.invalid/')
    await page.locator('.engine-settings-expand-button').click()
    const control = page.locator('.engine-login-control')
    await control.getByRole('button',{name:'登录账号',exact:true}).waitFor()
    await page.screenshot({path:path.join(output,`idle-${width}.png`)})
    await control.getByRole('button',{name:'登录账号',exact:true}).click()
    const link = control.getByRole('link',{name:'打开浏览器授权'})
    await link.waitFor()
    assert.equal(await link.getAttribute('target'), '_blank')
    await control.getByLabel('授权码',{exact:true}).fill('browser-fixture-code')
    const geometry = await control.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return {left:bounds.left,right:bounds.right,overflow:element.scrollWidth>element.clientWidth,
        controls:[...element.querySelectorAll('input,button,a')].map(item=>({tag:item.tagName,width:item.getBoundingClientRect().width,height:item.getBoundingClientRect().height}))}
    })
    assert.ok(geometry.left>=0 && geometry.right<=width && !geometry.overflow, JSON.stringify(geometry))
    await page.screenshot({path:path.join(output,`waiting-${width}.png`)})
    assert.ok(geometry.controls.every(item=>item.width>0&&item.height>=(width<=1023?32:24)),JSON.stringify(geometry))
    await control.getByRole('button',{name:'完成登录',exact:true}).click()
    await control.getByText('正在验证授权…',{exact:true}).waitFor()
    assert.equal(await control.locator('input').count(),0)
    await page.screenshot({path:path.join(output,`submitting-${width}.png`)})
    await page.evaluate(()=>window.engineLoginFixture.succeed())
    await control.getByText('登录成功',{exact:true}).waitFor()
    assert.deepEqual(await page.evaluate(()=>window.engineLoginFixture.submissions()),['browser-fixture-code'])
    await control.getByRole('button',{name:'重新登录',exact:true}).click()
    await control.getByRole('button',{name:'取消登录',exact:true}).click()
    await control.getByText('已取消登录',{exact:true}).waitFor()
    await control.getByRole('button',{name:'登录账号',exact:true}).click()
    await page.evaluate(()=>window.engineLoginFixture.fail())
    await control.getByText('登录已超时，请重新登录。',{exact:true}).waitFor()
    await page.screenshot({path:path.join(output,`timeout-${width}.png`)})
    assert.deepEqual(errors,[])
    results.push({width,geometry,codeSubmission:true,completion:true,cancel:true,timeout:true})
    await page.close()
  }
} finally { await browser.close() }
await fs.writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2))
console.log(JSON.stringify(results))
