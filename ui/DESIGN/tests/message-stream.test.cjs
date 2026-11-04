const { chromium } = require('../../../apps/desktop/node_modules/playwright-core');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('file://' + path.resolve(__dirname, '../message-stream.html'));
    assert.equal(await page.locator('.message').count(), 4);
    await page.waitForTimeout(650);
    await page.locator('#pause').click();
    const paused = await page.locator('.body').allTextContents();
    await page.waitForTimeout(300);
    assert.deepEqual(await page.locator('.body').allTextContents(), paused);
    await page.locator('#pause').click();
    await page.locator('#finish').click();
    const complete = await page.locator('.body').allTextContents();
    assert.ok(complete.every(text => text === complete[0] && text.includes('👩🏽‍💻')));
    await page.locator('#replay').click();
    await page.waitForTimeout(150);
    assert.ok((await page.locator('.body').first().textContent()).length < complete[0].length);
    await page.locator('#network').selectOption('burst');
    await page.waitForFunction(() => [...document.querySelectorAll('.state')].every(el => el.textContent === '已完成'), { }, { timeout: 20000 });
    assert.deepEqual(await page.locator('.body').allTextContents(), complete);
    for (const width of [320, 390, 1023, 1440]) {
      await page.setViewportSize({width, height:900});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await page.waitForTimeout(200);
    await page.screenshot({path:'/tmp/workstep-message-stream.png', fullPage:true});
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.locator('#replay').click();
    await page.locator('#finish').click();
    assert.deepEqual(await page.locator('.body').allTextContents(), complete);
    assert.deepEqual(errors, []);
    console.log('PASS: pause/resume, replay, burst completion, Unicode, reduced motion, four viewport widths');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
