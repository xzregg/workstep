// Production UI + isolated API fixtures. No daemon or real model is started.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const dist = path.resolve(__dirname, '../dist');
const output = path.resolve(__dirname, '../node_modules/.tmp/skin-studio-qa');
const workspace = { project_id: 'design', project_name: '皮肤设计', session_id: 'design-session', workspace_path: '/tmp/design', package_path: '/tmp/design/skin', prompt: '请先阅读皮肤规范，通过 skin CLI 制作皮肤。' };
const initial = { manifest: { id: 'my-skin', name: '我的专属皮肤', version: '1.0.0', schema_version: 1, color_scheme: 'light' }, tokens: {}, styles: {}, layout: {}, revision: 'a'.repeat(64), asset_base: '' };
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [320, 390, 1023, 1280]) {
      let draft = structuredClone(initial); const calls = [], errors = [];
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      await context.addInitScript(() => {
        if (window !== window.top) return
        localStorage.setItem('workstep.locale', 'zh-CN');
        localStorage.setItem('workstep:browser-actor:v2', JSON.stringify({ id: 'qa', name: '验收', deviceId: 'qa', deviceName: '验收浏览器' }));
      });
      await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url()); const pathname = url.pathname;
        if (pathname.startsWith('/api/')) {
          calls.push({ path: pathname, method: req.method(), body: req.postDataJSON() }); let data = {};
          if (pathname === '/api/skins/onboarding') data = workspace;
          else if (pathname === '/api/skins/validate') data = { ok: true, skin: draft, coverage: { overridden: [], inherited: [] }, visual_checked: false };
          else if (pathname === '/api/skins/draft') { draft = { ...req.postDataJSON().skin, revision: 'b'.repeat(64) }; data = { ok: true, skin: draft, coverage: { overridden: [], inherited: [] }, visual_checked: false }; }
          else if (pathname === '/api/skins') data = [];
          else if (pathname === '/api/project/list') data = { projects: [{ id: 'original', name: '验收项目', path: '/tmp/original', workflows: [], steps: {} }] };
          else if (pathname === '/api/task/list') data = { tasks: [] };
          else if (pathname === '/api/assistants') data = { assistants: [{ name: 'chat_session', configured: { engine: 'pydantic_ai' }, resolved: { engine: 'pydantic_ai' }, available_engines: [{ id: 'pydantic_ai', installed: true, enabled: true, configured: true, verified: true, built_in: true }] }] };
          else if (pathname === '/api/chat-sessions/design-session') data = { id: 'design-session', project_id: 'design', title: '皮肤设计', engine: 'pydantic_ai', messages: [{ id: 'hello', role: 'assistant', content: '先说说你喜欢的颜色，右侧也可以手动微调。', status: 'done', events: [] }], running: false };
          else if (pathname.includes('action')) data = { runs: [], active_action_ids: [] };
          else if (pathname.includes('chat-sessions')) data = { sessions: [] };
          else if (pathname.includes('provider')) data = { providers: [] };
          else if (pathname.includes('engine')) data = { engines: [], models: [], defaults: {} };
          else if (pathname === '/api/system-settings') data = { user_name: '验收', open_mode: false };
          return route.fulfill({ json: data });
        }
        let file = path.join(dist, pathname.replace(/^\//, ''));
        if (!file.startsWith(dist + path.sep)) return route.abort();
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
        return route.fulfill({ body: fs.readFileSync(file), contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream' });
      });
      await context.routeWebSocket('**/ws', () => {});
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto('http://skin-studio-qa.local/tasks?project=' + encodeURIComponent('验收项目'));
      if (width <= 1023) await page.getByRole('button', { name: '打开导航', exact: true }).click();
      await page.locator('.layout-sidebar-settings-button').click();
      await page.locator('.settings-nav-button').filter({ hasText: '外观与皮肤' }).click();
      await page.getByRole('button', { name: '聊天制作皮肤', exact: true }).click();
      await page.locator('.skin-studio-controls fieldset').waitFor();
      await page.locator('.skin-studio-chat .chat-message-row').waitFor();
      const send = await page.locator('.skin-studio-chat .chat-input-send').boundingBox();
      assert.ok(send && send.x >= 0 && send.x + send.width <= width, 'send control remains reachable at ' + width);
      assert.ok(page.url().includes('/tasks?project='), 'embedded chat preserves route');
      await page.locator('.skin-studio-controls fieldset input:not([type]), .skin-studio-controls fieldset input[type=text]').first().fill('微调验收皮肤');
      await page.locator('.skin-studio-palette button[aria-label="#7c65d5"]').click();
      await page.getByRole('button', { name: '保存微调', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.skin-studio-controls fieldset').disabled);
      assert.equal(draft.manifest.name, '微调验收皮肤'); assert.equal(draft.tokens.accent, '#7c65d5');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.evaluate(() => document.getElementById('workstep-skin-style')), null, 'draft stays inside preview');
      await page.locator('.skin-studio-controls').evaluate(el => el.scrollTop = 0);
      await page.screenshot({ path: path.join(output, 'studio-' + width + '.png') });
      assert.deepEqual(errors, [], 'browser errors at ' + width);
      assert.ok(calls.some(c => c.path === '/api/chat-sessions/design-session'));
      assert.equal(calls.some(c => c.method === 'POST' && c.path.includes('/assistant/')), false);
      await context.close();
    }
    console.log(JSON.stringify({ ok: true, viewports: [320, 390, 1023, 1280], output }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
