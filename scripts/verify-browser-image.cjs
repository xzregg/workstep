// Run inside the browser runtime or WorkStep image; no network or credentials needed.
const assert = require('node:assert/strict')
const http = require('node:http')
const { chromium } = require('/opt/workstep-browser/node_modules/playwright')

async function main() {
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(`<title>浏览器验证</title><label>名称<input id="name"></label>
      <button onclick="document.querySelector('output').textContent=document.querySelector('input').value">执行</button>
      <output></output>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    assert.equal(await page.title(), '浏览器验证')
    await page.getByLabel('名称').fill('WorkStep 沙箱')
    await page.getByRole('button', { name: '执行' }).click()
    assert.equal(await page.locator('output').textContent(), 'WorkStep 沙箱')
    const screenshot = await page.screenshot()
    assert.equal(screenshot.subarray(1, 4).toString(), 'PNG')
    console.log(`PASS Chromium ${browser.version()}: navigation, Chinese form, click, JavaScript, PNG screenshot`)
  } finally {
    if (browser) await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
