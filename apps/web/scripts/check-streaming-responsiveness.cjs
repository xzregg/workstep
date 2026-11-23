// Isolated production components + actual Vite worker bundle; no daemon/server.
// First build: node node_modules/vite/bin/vite.js build --outDir ../../tmp/stream-worker-build
const { buildSync } = require('esbuild');
const { chromium } = require('../../desktop/node_modules/playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const web = path.resolve(__dirname, '..');
const root = path.resolve(web, '../..');
const output = path.join(root, 'tmp/stream-render-check');
fs.mkdirSync(output, { recursive: true });
const assets = path.join(root, 'tmp/stream-worker-build/assets');
const workerFile = fs.readdirSync(assets).find(name => /^markdown\.worker-.*\.js$/.test(name));
assert.ok(workerFile, 'build the production worker first');
const worker = fs.readFileSync(path.join(assets, workerFile), 'utf8');
const bundle = buildSync({
  entryPoints: [path.join(__dirname, 'fixtures/streaming-responsiveness.tsx')],
  bundle: true, write: false, format: 'esm', jsx: 'automatic',
  loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
}).outputFiles[0].text;
const css = ['index.css', 'components/Layout.css', 'components/MessageResponseFooter.css', 'mobile.css']
  .map(file => fs.readFileSync(path.join(web, 'src', file), 'utf8')).join('\n');
const html = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}
main.chat-history-scroll{position:fixed;inset:60px 0 160px;height:auto}
#stream-composer{position:fixed;bottom:0;left:0;right:0;background:var(--bg);padding:12px}
</style><div id="root"></div><script type="module">${bundle}</script>`;
fs.writeFileSync(path.join(output, 'fixture.html'), html);
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const width = Number(process.env.WORKSTEP_STREAM_WIDTH || 390);
    const mobile = width <= 1023;
    for (const kind of process.argv.slice(2).length ? process.argv.slice(2) : ['live', 'list', 'quote', 'table', 'code']) {
      const name = width === 390 ? kind : kind + '-' + width;
      const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: mobile, isMobile: mobile });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('http://stream.test/**', route => {
        const url = route.request().url();
        return route.fulfill({
          contentType: url.includes('markdown.worker.ts') ? 'text/javascript' : url.includes('/api/') ? 'application/json' : 'text/html',
          body: url.includes('markdown.worker.ts') ? worker : url.includes('/api/') ? '{}' : html,
        });
      });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await page.goto('http://stream.test/');
      await page.waitForFunction(() => window.start);
      if (kind === 'live') {
        // Preload the long reply, then measure sustained updates across the rolling event limit.
        await page.evaluate(() => window.start('live'));
        await page.waitForFunction(() => document.querySelectorAll('main strong').length > 600);
        await page.waitForTimeout(1000);
      }
      await page.evaluate(kind => {
        window.tasks = []; window.clicks = []; window.inputs = []; window.revealGaps = [];
        new PerformanceObserver(list => window.tasks.push(...list.getEntries().map(e => e.duration))).observe({ type: 'longtask' });
        for (const type of ['click', 'input']) document.addEventListener(type, event => {
          const at = event.timeStamp;
          requestAnimationFrame(() => requestAnimationFrame(() => (type === 'click' ? window.clicks : window.inputs).push(performance.now() - at)));
        }, true);
        if (kind !== 'live') {
          window.start(kind);
        } else {
          let previous = performance.now();
          window.revealObserver = new MutationObserver(() => {
            const now = performance.now();
            window.revealGaps.push(now - previous);
            previous = now;
          });
          window.revealObserver.observe(document.querySelector('.llm-message-timeline'), {
            subtree: true, childList: true, characterData: true,
          });
        }
      }, kind);
      if (kind !== 'live') await page.waitForTimeout(1000);
      for (let i = 0; i < 5; i++) {
        if (mobile) {
          await page.locator('.mobile-header-left button').first().tap();
          await page.waitForFunction(() => document.querySelector('.responsive-navigation').classList.contains('is-open'));
          await page.locator('.navigation-close').tap();
        }
        await page.locator('textarea').first().fill('补充消息 ' + i);
        const send = page.locator('.chat-input-send');
        if (mobile) await send.tap();
        else await send.click();
        await page.waitForFunction(count => window.sent.length === count, i + 1);
      }
      if (kind === 'live') await page.waitForTimeout(1000);
      await page.evaluate(() => { window.revealObserver?.disconnect(); window.stop(); });
      await page.waitForFunction(() => document.querySelector('.llm-message-timeline, .markdown-message').textContent.endsWith('终点确认'));
      await page.waitForTimeout(600);
      const metrics = await page.evaluate(() => ({
        sent: window.sent, clickPaintMs: window.clicks, inputPaintMs: window.inputs,
        longTasks: window.tasks, fallback: !!document.querySelector('.markdown-worker-fallback'),
        revealUpdates: window.revealGaps.length, maxRevealGapMs: Math.max(0, ...window.revealGaps),
        bottomGap: (() => {
          const list = document.querySelector('main');
          return list.scrollHeight - list.clientHeight - list.scrollTop;
        })(),
        formatted: document.querySelectorAll('main li,main blockquote,main td,main pre,main strong').length,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }));
      fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(metrics, null, 2));
      await page.screenshot({ path: path.join(output, name + '.png') });
      if (kind === 'live' && mobile) {
        await page.locator('.mobile-header-left button').first().tap();
        await page.waitForFunction(() => document.querySelector('.responsive-navigation').classList.contains('is-open'));
        await page.screenshot({ path: path.join(output, name + '-menu.png'), animations: 'disabled' });
      }
      assert.deepEqual(metrics.sent, Array.from({ length: 5 }, (_, i) => '补充消息 ' + i));
      assert.equal(metrics.fallback, false, 'fast plain-text fallback is not a rich-text performance pass');
      assert.ok(metrics.formatted > 0);
      assert.equal(metrics.overflow, false);
      assert.ok(Math.max(...metrics.clickPaintMs, ...metrics.inputPaintMs) < 100, 'interaction delayed over 100ms');
      assert.ok(Math.max(0, ...metrics.longTasks) < 100, 'main-thread task blocked over 100ms');
      if (kind === 'live') {
        assert.ok(metrics.revealUpdates >= 10, 'reply stopped updating during interaction');
        assert.ok(metrics.maxRevealGapMs < 350, 'reply stopped updating for over 350ms');
        assert.ok(metrics.bottomGap <= 2, 'the transcript lost bottom follow');
      }
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ kind, width, maxClickMs: Math.max(...metrics.clickPaintMs), maxInputMs: Math.max(...metrics.inputPaintMs), maxRevealGapMs: metrics.maxRevealGapMs, longTasks: metrics.longTasks }));
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
