// Real editor with synthetic Markdown; no app server or user files required.
const { buildSync } = require('esbuild');
const { chromium } = require('../../desktop/node_modules/playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const output = path.resolve(__dirname, '../../../tmp/source-editor-layout');
fs.mkdirSync(output, { recursive: true });
buildSync({
  stdin: { contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import GitCodeEditor from './src/components/git/GitCodeEditor';
    import './src/index.css';
    import './src/mobile.css';
    import './src/components/git/git.css';
    function App() {
      const [value, setValue] = useState(Array.from({length: 80}, (_, i) =>
        '第' + (i + 1) + '行 Markdown **文字** ' + 'long text '.repeat(20)).join('\\n'));
      return <GitCodeEditor filename="example.md" value={value} targetLine={1}
        editable ariaLabel="Markdown" onChange={setValue} />;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `, loader: 'tsx', resolveDir: path.resolve(__dirname, '..') },
  bundle: true, outfile: path.join(output, 'fixture.js'), format: 'iife', jsx: 'automatic',
});

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [320, 390, 1023, 1024, 1440]) {
      for (const scale of [1, 1.5]) {
        const page = await browser.newPage({ viewport: { width, height: 740 }, hasTouch: width <= 1023 });
        try {
          await page.route('http://source-editor.test/**', route => route.fulfill({
            contentType: 'text/html',
            body: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root" style="height:600px"></div></body></html>',
          }));
          await page.goto('http://source-editor.test/');
          await page.addStyleTag({ path: path.join(output, 'fixture.css') });
          await page.addScriptTag({ path: path.join(output, 'fixture.js') });
          const input = page.locator('textarea');
          await input.waitFor();
          await page.evaluate(scale => document.documentElement.style.setProperty('--font-scale', String(scale)), scale);
          const metrics = await page.evaluate(() => {
            const input = document.querySelector('textarea');
            const code = document.querySelector('.git-source-highlight code');
            const a = getComputedStyle(input), b = getComputedStyle(code);
            return { inputFont: a.fontSize, displayFont: b.fontSize,
              inputLine: a.lineHeight, displayLine: b.lineHeight,
              inputFill: a.webkitTextFillColor,
              highlightVisibility: getComputedStyle(code.querySelector('.code-preview-line-content')).visibility,
              overflow: document.documentElement.scrollWidth > innerWidth };
          });
          assert.equal(metrics.inputFont, metrics.displayFont, `${width}/${scale}: font mismatch`);
          assert.equal(metrics.inputFont, `${12 * scale}px`, `${width}/${scale}: source text must keep the compact code size`);
          assert.equal(metrics.inputLine, metrics.displayLine, `${width}/${scale}: line height mismatch`);
          assert.equal(metrics.overflow, false);
          if (width <= 1023) {
            assert.notEqual(metrics.inputFill, 'rgba(0, 0, 0, 0)', 'mobile must show the native input text');
            assert.equal(metrics.highlightVisibility, 'hidden', 'mobile must not paint a stale duplicate');
          }
          for (const scroll of [0, 600]) {
            await input.evaluate((element, top) => {
              element.scrollTop = top;
              element.dispatchEvent(new Event('scroll', { bubbles: true }));
            }, scroll);
            const target = await page.evaluate(() => {
              const input = document.querySelector('textarea');
              const pre = document.querySelector('.git-source-highlight');
              const bounds = input.getBoundingClientRect();
              const line = [...pre.querySelectorAll('.code-preview-line')].find(row => {
                const r = row.getBoundingClientRect();
                return r.top >= bounds.top + 40 && r.bottom < bounds.bottom - 40;
              });
              const range = document.createRange();
              range.selectNodeContents(line.querySelector('.code-preview-line-content'));
              const rect = range.getClientRects()[0];
              return { line: Number(line.dataset.line), x: rect.left + 1, y: rect.top + rect.height / 2,
                inputScroll: input.scrollTop, displayScroll: pre.scrollTop };
            });
            assert.equal(target.inputScroll, target.displayScroll);
            if (width <= 1023) await page.touchscreen.tap(target.x, target.y);
            else await page.mouse.click(target.x, target.y);
            const selectedLine = await input.evaluate(element => element.value.slice(0, element.selectionStart).split('\n').length);
            assert.equal(selectedLine, target.line, `${width}/${scale}/${scroll}: clicked a different line`);
            await page.keyboard.insertText('编辑');
            const editedLine = (await input.inputValue()).split('\n').findIndex(line => line.includes('编辑')) + 1;
            assert.equal(editedLine, target.line, `${width}/${scale}/${scroll}: edited a different line`);
            await page.keyboard.press('Backspace');
            await page.keyboard.press('Backspace');
            const before = await input.inputValue();
            const selected = await input.evaluate((element, line) => {
              const start = element.value.split('\n').slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0);
              element.setSelectionRange(start, start + 3);
              return { start, end: start + 3 };
            }, target.line);
            await page.keyboard.press('Backspace');
            const expected = before.slice(0, selected.start) + before.slice(selected.end);
            assert.equal(await input.inputValue(), expected, 'Backspace must remove the selected text');
            await page.waitForFunction(expected => {
              const displayed = [...document.querySelectorAll('.code-preview-line-content')]
                .map(node => node.textContent).join('\n');
              return displayed === expected;
            }, expected);
          }
          if (width <= 1023) {
            const session = await page.context().newCDPSession(page);
            await input.focus();
            await session.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 });
            assert.ok((await input.inputValue()).includes('nihao'), 'native input must keep the IME draft');
            await page.screenshot({ path: path.join(output, `${width}-${scale}-composition.png`) });
            await session.send('Input.insertText', { text: '你好' });
            assert.ok((await input.inputValue()).includes('你好'), 'IME commit must update the input');
            await page.keyboard.press('Backspace');
            assert.ok(!(await input.inputValue()).includes('你好'), 'Backspace must delete committed IME text');
            await session.detach();
          }
          await page.screenshot({ path: path.join(output, `${width}-${scale}.png`) });
          console.log(JSON.stringify({ width, scale, ...metrics }));
        } finally { await page.close(); }
      }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
