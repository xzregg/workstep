// Execute inside the test container. All writes stay in its disposable project/HOME.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('/opt/workstep-browser/node_modules/playwright')

const output = process.argv[2] || '/tmp/workstep-browser-report'
const origin = process.env.WORKSTEP_TEST_ORIGIN || 'http://127.0.0.1:8765'
const projectName = `browser-ui-${Date.now()}`
const results = []
const pageErrors = []
const serverErrors = []
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))

async function main() {
  await fs.mkdir(output, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('response', response => { if (response.status() >= 500) serverErrors.push({ path: new URL(response.url()).pathname, status: response.status() }) })
  async function test(id, name, steps, action) {
    const start = Date.now()
    const item = { id, name, steps, status: 'PASS', screenshot: `${id}.png` }
    try { await action() } catch (error) { item.status = 'FAIL'; item.error = error.message.slice(0, 1400) }
    item.durationMs = Date.now() - start
    await page.screenshot({ path: path.join(output, item.screenshot), fullPage: true, animations: 'disabled' })
    results.push(item)
    console.log(`${item.status} ${id}: ${name}`)
  }
  try {
    await test('01', '首次使用：填写身份并进入应用', '打开 WorkStep → 填写“浏览器测试员” → 点击“直接进入”。', async () => {
      const response = await page.goto(origin)
      assert.equal(response.status(), 200)
      await page.locator('#first-use-name').fill('浏览器测试员')
      await page.getByRole('button', { name: '直接进入', exact: true }).click()
      await page.locator('#first-use-name').waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: '新建对话', exact: true }).waitFor()
    })
    await test('02', '打开创建项目并检查空目录选择', '点击“添加项目”，等待目录列表，确认未选择目录时“确定”禁用。', async () => {
      await page.getByRole('button', { name: '添加项目', exact: true }).click()
      await page.getByRole('listbox').waitFor()
      await page.getByRole('button', { name: /新建文件夹/ }).waitFor({ state: 'visible' })
      assert.equal(await page.getByRole('button', { name: '确定', exact: true }).isDisabled(), true)
    })
    await test('03', '目录名称校验与实际创建', '通过目录选择器输入带空格名称验证错误，再创建唯一的 browser-ui 测试目录。', async () => {
      await page.getByRole('button', { name: /新建文件夹/ }).click()
      const input = page.getByPlaceholder('文件夹名称')
      await input.fill('invalid folder')
      await input.press('Enter')
      await page.getByText(/不能|不允许|无效|禁止/).first().waitFor()
      await input.fill(projectName)
      await input.press('Enter')
      await page.getByRole('option', { name: projectName, exact: false }).waitFor()
    })
    await test('04', '通过界面初始化测试项目', '单击新目录 → 点击“确定” → 验证项目进入任务页。', async () => {
      await page.getByRole('option', { name: projectName, exact: false }).click()
      await page.getByRole('button', { name: '确定', exact: true }).click()
      await page.getByRole('listbox').waitFor({ state: 'hidden' })
      await page.waitForURL(url => url.searchParams.get('project') === projectName)
      assert.equal(await page.getByText(projectName, { exact: true }).count() > 0, true)
    })
    await test('05', '项目页刷新后保持选择', '刷新浏览器 → 检查 URL 和项目名称仍指向刚创建的测试项目。', async () => {
      await page.reload()
      await page.getByText(projectName, { exact: true }).filter({ visible: true }).first().waitFor()
      assert.equal(new URL(page.url()).searchParams.get('project'), projectName)
    })
    await test('06', '打开并操作外观设置', '点击“外观” → 把字体切换为衬线字体 → 验证控件值。', async () => {
      await page.getByRole('button', { name: '外观', exact: true }).click()
      await page.locator('#appearance-font-family').selectOption('serif')
      assert.equal(await page.locator('#appearance-font-family').inputValue(), 'serif')
    })
    await test('07', '切换语言并恢复简体中文', '在外观设置中选择 English → 验证 html lang → 切回简体中文。', async () => {
      await page.locator('#appearance-language').selectOption('en-US')
      await page.waitForFunction(() => document.documentElement.lang === 'en-US')
      await page.locator('#appearance-language').selectOption('zh-CN')
      await page.waitForFunction(() => document.documentElement.lang === 'zh-CN')
    })
    await test('08', '390px 移动端实际渲染', '把浏览器视口改为 390×844，检查根页面没有水平溢出并截图。', async () => {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.waitForTimeout(200)
      const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }))
      assert.ok(dimensions.scroll <= dimensions.width + 1, JSON.stringify(dimensions))
    })
    await test('09', '创建对话并输入草稿', '打开测试项目对话页 → 点击“新建对话” → 输入中文草稿，核对输入值，不点击发送。', async () => {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.goto(origin + '/chat?project=' + encodeURIComponent(projectName))
      await page.getByRole('button', { name: '新建对话', exact: true }).click()
      const input = page.locator('textarea.chat-input-text-segment').first()
      const draft = '这是一条浏览器自动化测试草稿：验证输入、截图和报告生成。'
      await input.fill(draft)
      assert.equal(await input.inputValue(), draft)
    })
    await test('10', '页面异常与后端错误检查', '检查本次操作产生的页面 JavaScript 异常、HTTP 5xx 和健康接口。', async () => {
      assert.equal(pageErrors.length, 0, 'pageerror count=' + pageErrors.length)
      assert.equal(serverErrors.length, 0, JSON.stringify(serverErrors))
      const response = await page.request.get(origin + '/api/health')
      assert.equal(response.status(), 200)
      assert.equal((await response.json()).status, 'ok')
    })
    const summary = {
      generatedAt: new Date().toISOString(), image: process.env.WORKSTEP_TEST_IMAGE || 'workstep:latest', platform: `${process.platform}/${process.arch}`,
      browser: `Chromium ${browser.version()}`, viewport: '1440×1000 / 390×844',
      passed: results.filter(result => result.status === 'PASS').length,
      failed: results.filter(result => result.status === 'FAIL').length,
      projectName, pageErrors, serverErrors, results,
      limitations: ['未发送模型请求；未验证 Codex/MCP 端到端调用。', '使用测试容器独立 Home 和新建测试目录，不操作原 8755 项目。', '截图由容器内 Chromium 实际渲染；报告未包含供应商配置、密钥、HAR 或私有聊天内容。']
    }
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(summary, null, 2))
    const cards = await Promise.all(results.map(async result => {
      const png = (await fs.readFile(path.join(output, result.screenshot))).toString('base64')
      return `<section><header><span class="badge ${result.status}">${result.status}</span><h2>${escape(result.id)} · ${escape(result.name)}</h2><small>${result.durationMs} ms</small></header><p>${escape(result.steps)}</p>${result.error ? `<pre>${escape(result.error)}</pre>` : ''}<a href="data:image/png;base64,${png}" download="case-${result.id}.png"><img alt="${escape(result.name)}的真实界面截图" src="data:image/png;base64,${png}"></a></section>`
    }))
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>WorkStep 浏览器实际操作测试报告</title><style>body{margin:0;background:#f3f6fa;color:#182331;font:15px/1.65 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:40px 24px}h1{font-size:30px;line-height:1.3}h2{font-size:18px;margin:0}p{color:#4b5a6e}section,.intro{background:white;border:1px solid #dce3ec;border-radius:12px;padding:22px;margin:20px 0}header{display:flex;align-items:center;gap:12px}small{margin-left:auto;color:#6b7686}.badge{padding:3px 9px;border-radius:5px;font-size:12px;font-weight:700}.PASS{color:#087f50;background:#e0f5e9}.FAIL{color:#a82020;background:#ffe7e7}img{max-width:100%;max-height:720px;object-fit:contain;display:block;margin:18px auto 0;border:1px solid #e1e5eb}pre{white-space:pre-wrap;background:#fff1f1;padding:12px}li{margin:6px 0}.count{font-size:24px;font-weight:700}.meta{font-family:monospace;font-size:13px}@media(max-width:600px){main{padding:18px 12px}section{padding:14px}header{flex-wrap:wrap}h1{font-size:25px}}@media print{section{break-inside:avoid}main{padding:0}body{background:white}img{max-height:600px}}</style><main><h1>WorkStep 浏览器实际操作测试报告</h1><div class="intro"><div class="count">${summary.passed} 通过 / ${summary.failed} 失败</div><p>使用容器内浏览器进行点击、填写、项目初始化、刷新、设置修改和移动端渲染；每个用例保留真实 PNG 截图。</p><div class="meta">${escape(summary.generatedAt)} · ${escape(summary.image)} · ${escape(summary.browser)} · ${escape(summary.platform)}</div><ul>${summary.limitations.map(value => `<li>${escape(value)}</li>`).join('')}</ul><p>截图可点击下载。此 HTML 内嵌全部图片，可离线打开。</p></div>${cards.join('')}</main></html>`
    await fs.writeFile(path.join(output, 'report.html'), html)
    console.log(`REPORT ${summary.passed} passed / ${summary.failed} failed: ${output}/report.html`)
    if (summary.failed) process.exitCode = 1
  } finally { await browser.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
