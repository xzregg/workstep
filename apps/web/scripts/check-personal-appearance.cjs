// Production UI acceptance with isolated fixtures; no daemon is started.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const dist = path.resolve(__dirname, '../dist');
const output = path.resolve(__dirname, '../node_modules/.tmp/personal-appearance-qa');
const skin = { manifest: { id:'ocean', name:'海洋', version:'1.0.0', schema_version:1, color_scheme:'dark' }, tokens:{bg:'#101923', surface:'#182838', fg:'#eaf2fa', accent:'#56b8ff', 'accent-fg':'#102030'}, styles:{}, layout:{}, revision:'a'.repeat(64), asset_base:'' };
const defaults = {skin_id:'default', language:'zh-CN', font_size:'standard', font_family:'system'};
const users = {alice:{...defaults, skin_id:'ocean', font_size:'large'}, bob:{...defaults}};
const errors = [], writes = [];
(async () => {
  fs.mkdirSync(output, {recursive:true});
  const browser = await chromium.launch({channel:'chrome', headless:true});
  async function open(user, width, destination = 'appearance') {
    const context = await browser.newContext({viewport:{width, height:900}});
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      const pathname = url.pathname.replace(/^\/workspace\/device/, '');
      if (pathname.startsWith('/api/')) {
        let data = {};
        if (pathname === '/api/appearance/preferences') {
          if (req.method() === 'PATCH') {
            assert.equal(req.headers()['x-appearance-scope'], user);
            const patch = req.postDataJSON(); writes.push({user, patch}); Object.assign(users[user], patch);
          }
          data = {scope:user, preferences:users[user]};
        } else if (pathname === '/api/remote/session') data = {user_id:user, username:user, device_id:'device', device_name:'外观演示设备', gateway_url:'http://appearance-qa.local', project_id:'published', host_project_id:'project', access_level:'read', task_create:false, share_create:false, can_manage_project_access:false};
        else if (pathname === '/api/project/project/summary') data = {id:'project', name:'外观演示', steps:{steps:[], connections:[]}, workflows:[]};
        else if (pathname === '/api/skins') data = [{manifest:skin.manifest, revision:skin.revision}];
        else if (pathname === '/api/skins/ocean') data = skin;
        else if (pathname === '/api/language-packs') data = [];
        else if (pathname === '/api/chat-sessions') data = {sessions:[]};
        else if (pathname === '/api/task/list') data = {tasks:[]};
        else if (pathname.includes('quick-buttons')) data = {buttons:[]};
        else if (pathname.includes('engine')) data = {engines:[]};
        return route.fulfill({json:data});
      }
      let file = path.join(dist, pathname.replace(/^\//, ''));
      if (!file.startsWith(dist + path.sep)) return route.abort();
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
      const mime = {'.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml'}[path.extname(file)] || 'application/octet-stream';
      return route.fulfill({body:fs.readFileSync(file), contentType:mime});
    });
    await context.routeWebSocket('**/ws/workspace/device', () => {});
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://appearance-qa.local/workspace/device/' + destination);
    if (destination === 'appearance') await page.locator('.skin-settings-workspace').waitFor();
    else await page.locator('.layout-sidebar-settings-button').waitFor({state:'attached'});
    return {context, page};
  }
  try {
    for (const width of [320, 390, 1023, 1280]) {
      const {context, page} = await open('alice', width, 'tasks');
      if (width <= 1023) await page.getByRole('button', {name:'打开导航', exact:true}).first().click();
      await page.locator('.layout-sidebar-settings-button').click();
      await page.locator('.skin-settings-workspace').waitFor();
      await page.waitForFunction(() => !document.querySelector('.responsive-navigation.is-open'));
      await page.waitForFunction(() => innerWidth > 1023 || document.querySelector('.responsive-navigation').getBoundingClientRect().right <= 1);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.skinId), 'ocean');
      assert.equal(await page.evaluate(() => document.documentElement.dataset.fontSize), 'large');
      assert.equal(await page.getByRole('button', {name:'聊聊外观怎么改', exact:true}).count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`);
      await page.screenshot({path:path.join(output, `appearance-${width}.png`)});
      await context.close();
    }
    const alice = await open('alice', 1280), bob = await open('bob', 1280);
    await alice.page.locator('.settings-appearance-size').getByRole('button', {name:'特大', exact:true}).click();
    await alice.page.waitForFunction(() => document.querySelector('.appearance-sync-status')?.textContent?.includes('当前选择'));
    await alice.page.waitForFunction(() => document.querySelector('.appearance-sync-status')?.textContent?.includes('当前选择'));
    assert.equal(users.alice.font_size, 'extraLarge');
    assert.equal(users.bob.font_size, 'standard');
    assert.equal(await bob.page.evaluate(() => document.documentElement.dataset.skinId), 'default');
    await alice.context.close();
    const phone = await open('alice', 390);
    assert.equal(await phone.page.evaluate(() => document.documentElement.dataset.fontSize), 'extraLarge');
    assert.equal(await phone.page.evaluate(() => document.documentElement.dataset.skinId), 'ocean');
    await phone.context.close(); await bob.context.close();
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({viewports:4, writes, errors}, null, 2));
    console.log(JSON.stringify({ok:true, viewports:4, output}));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
