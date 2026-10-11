// Real browser acceptance against the production build; no daemon/server is started.
// All resources and API requests are fulfilled with isolated fixtures.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dist = path.resolve(__dirname, '../dist');
const example = path.resolve(__dirname, '../../daemon/data/skins/example');
const output = process.env.SKIN_QA_DIR || path.resolve(__dirname, '../node_modules/.tmp/skin-qa');
const manifest = JSON.parse(fs.readFileSync(path.join(example, 'skin.json')));
const config = JSON.parse(fs.readFileSync(path.join(example, 'components.json')));
const skin = { manifest, tokens: JSON.parse(fs.readFileSync(path.join(example, 'tokens.json'))), ...config, revision: crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex'), asset_base: '' };
const defaultSkin = { manifest: { id: 'default', name: '默认皮肤', version: '1', schema_version: 1, color_scheme: 'light' }, tokens: {}, styles: {}, layout: {}, revision: 'default', asset_base: '' };
const project = { id: 'skin-qa', name: '皮肤验收', path: '/tmp/skin-qa', steps: [], workflows: [] };
const results = [], errors = [], writes = [];
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(skin => {
      localStorage.setItem('workstep.locale', 'zh-CN');
      localStorage.setItem('workstep:browser-actor:v2', JSON.stringify({ id: 'qa', name: '验收', deviceId: 'qa', deviceName: '验收浏览器' }));
      localStorage.setItem('workstep.skin.v1:', JSON.stringify(skin));
    }, skin);
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url()), pathname = url.pathname;
      if (pathname.startsWith('/api/')) {
        if (req.method() !== 'GET') writes.push(pathname);
        let data = {};
        if (pathname === '/api/skins') data = [defaultSkin, skin].map(s => ({ manifest: s.manifest, revision: s.revision }));
        else if (pathname === '/api/skins/default') data = defaultSkin;
        else if (pathname === '/api/skins/ocean') data = skin;
        else if (pathname === '/api/project/list') data = { projects: [project] };
        else if (pathname === '/api/task/list') data = { tasks: [] };
        else if (pathname === '/api/chat-sessions') data = { sessions: [] };
        else if (pathname === '/api/system-settings') data = { user_name: '验收', open_mode: false };
        else if (pathname.includes('engine')) data = { engines: [], models: [], config: {}, defaults: {}, available_engines: [] };
        else if (pathname.includes('provider')) data = { providers: [] };
        else if (pathname.includes('assistant')) data = { assistants: [] };
        else if (pathname.includes('skill')) data = { skills: [] };
        else if (pathname.includes('template')) data = { templates: [] };
        else if (pathname.includes('schedule')) data = { schedules: [] };
        else if (pathname.includes('quick-buttons')) data = { buttons: [] };
        return route.fulfill({ json: data });
      }
      let file = path.join(dist, pathname.replace(/^\//, ''));
      if (!file.startsWith(dist + path.sep)) return route.abort();
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
      const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
      return route.fulfill({ body: fs.readFileSync(file), contentType: mime });
    });
    await context.routeWebSocket('**/ws', () => {});
    let page;
    for (const width of [320, 390, 1023, 1024, 1280]) {
      // Each static viewport starts with a clean overlay history. Live breakpoint
      // changes are checked separately below without navigation interleaving.
      if (page) await page.close();
      page = await context.newPage(); page.setDefaultTimeout(8000);
      page.on('pageerror', e => errors.push(e.message));
      await page.setViewportSize({ width, height: 900 });
      await page.goto('http://skin-qa.local/tasks?project=' + encodeURIComponent(project.name));
      if (width <= 1023) await page.getByRole('button', { name: '打开导航', exact: true }).click();
      await page.locator('.layout-sidebar-settings-button').click();
      await page.locator('.settings-nav-button').filter({ hasText: '外观与皮肤' }).click();
      await page.locator('.skin-settings').waitFor();
      await page.waitForTimeout(150);
      const geometry = await page.evaluate(() => {
        const node = document.querySelector('.settings-dialog-panel');
        if (!node) throw new Error('settings absent: ' + document.body.innerText.slice(-1500));
        const rect = node.getBoundingClientRect();
        return { viewport: innerWidth, x: rect.x, right: rect.right, width: rect.width, overflow: document.documentElement.scrollWidth > innerWidth, bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() };
      });
      assert.equal(geometry.overflow, false, 'page overflow at ' + width);
      assert.ok(geometry.x >= -1 && geometry.right <= width + 1, 'settings within viewport at ' + width);
      assert.equal(geometry.bg, '#101923');
      results.push(geometry);
      await page.screenshot({ path: path.join(output, 'settings-' + width + '.png') });
      const trigger = page.locator('.skin-settings-showcase [role=combobox]').first();
      await trigger.click();
      await page.locator('.skin-select-panel').waitFor();
      const option = page.locator('.skin-select-option').first();
      const box = await option.boundingBox();
      if (width <= 1023) assert.ok(box.height >= 44, 'mobile option hit target at ' + width);
      assert.equal(await page.locator('.skin-select-option:disabled').count(), 1);
      await page.screenshot({ path: path.join(output, 'select-' + width + '.png') });
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.skin-select-panel').count(), 0);
    }
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.skin-settings').count(), 1, 'settings survive a breakpoint change');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.skin-settings').count(), 1, 'settings survive returning to desktop');
    await page.locator('.skin-settings-card').filter({ hasText: '默认皮肤' }).getByRole('button', { name: '预览', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.skinId === 'default');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.skinId), 'default');
    await page.locator('.skin-recovery').getByRole('button', { name: '取消预览', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.skinId), 'ocean');
    await page.locator('.skin-recovery').getByRole('button', { name: '恢复默认皮肤', exact: true }).click();
    assert.equal(await page.locator('.skin-recovery').count(), 0);
    assert.equal(await page.evaluate(() => document.getElementById('workstep-skin-style')), null);
    assert.equal(writes.length, 0, 'browser preferences do not write global settings');
    assert.deepEqual(errors, [], 'no browser errors');
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results, errors, writes }, null, 2));
    console.log(JSON.stringify({ ok: true, viewports: results.length, output }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
