// Renders the real dialog with synthetic recorded changes; no app server or project data needed.
const { buildSync } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '../../desktop/node_modules/playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'workstep-diff-layout-'));
buildSync({
  stdin: { contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {I18nProvider} from './src/i18n';
    import GitDiffDialog from './src/components/git/GitDiffDialog';
    import './src/index.css';
    import './src/mobile.css';
    import './src/components/git/git.css';
    const files = ['apps/web/src/components/Example.tsx', 'apps/web/src/components/Other.tsx', 'apps/web/tests/example.test.tsx', 'docs/example.md', 'README.md'];
    function App() {
      const [file, select] = useState(files[0]);
      return <I18nProvider><GitDiffDialog id="demo" files={files} path={file}
        comparison={{}} onSelect={select} onClose={()=>{}}
        recordedDiff={{path:file,old_path:file,base:null,target:null,before:'',after:'',binary:false,truncated:false,submodule:false,
          patch:'@@ -1,31 +1,31 @@\\n'+Array.from({length:30},(_,i)=>' '+ 'const example'+i+' = '+(i === 0 ? JSON.stringify('long content '.repeat(30)) : 'true')+';').join('\\n')+'\\n-short before\\n+short after\\n'}} /></I18nProvider>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `, loader: 'tsx', resolveDir: path.resolve(__dirname, '..') },
  bundle: true, outfile: path.join(output, 'fixture.js'), format: 'iife', jsx: 'automatic',
});
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [width, height] of [[320, 740], [390, 844], [1023, 768], [1440, 900]]) {
      const page = await browser.newPage({ viewport: { width, height }, hasTouch: width <= 1023 });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('http://diff-layout.test/**', route => route.fulfill({ contentType: 'text/html', body: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>' }));
      await page.goto('http://diff-layout.test/');
      await page.addStyleTag({ path: path.join(output, 'fixture.css') });
      await page.addScriptTag({ path: path.join(output, 'fixture.js') });
      await page.locator('.git-code-cell').first().waitFor();
      for (const split of [false, true]) {
        if (split) await page.locator('.git-diff-toolbar button').first().click();
        const metrics = await page.evaluate(() => {
          const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom }; };
          return { dialog:rect('.git-diff-dialog'), header:rect('.git-diff-dialog header'),
            tree:rect('.git-diff-file-tree'), list:rect('.git-diff-tree-list'),
            toolbar:rect('.git-diff-toolbar'), labels:rect('.git-diff-labels'), content:rect('.git-diff-content'),
            row:rect('.git-diff-tree-entry'), search:rect('.git-diff-tree-search'),
            overflow:document.documentElement.scrollWidth > innerWidth };
        });
        console.log(JSON.stringify({ width, height, split, metrics }));
        assert.equal(metrics.overflow, false, `${width}: horizontal overflow`);
        if (width <= 1023) {
          assert.ok(metrics.header.height <= 42, `${width}: title bar too tall: ${metrics.header.height}`);
          assert.ok(metrics.toolbar.height <= 42, `${width}: diff toolbar too tall: ${metrics.toolbar.height}`);
          assert.ok(metrics.labels.height <= 28, `${width}: labels too tall: ${metrics.labels.height}`);
          assert.ok(metrics.list.height >= 5 * metrics.row.height, `${width}: fewer than five visible tree rows`);
          assert.ok(metrics.content.height >= height * .52, `${width}: diff content gets too little space`);
          assert.ok(metrics.dialog.height >= height - 16, `${width}: dialog wastes viewport height`);
          assert.ok(metrics.search.y < metrics.list.y, `${width}: search must stay above tree`);
        } else {
          assert.ok(metrics.tree.x < metrics.content.x, 'desktop tree stays beside diff');
        }
        const backgrounds = await page.evaluate(() => {
          const scrollers = document.querySelector('.git-diff-dialog').classList.contains('split')
            ? [...document.querySelectorAll('.git-code-pane')]
            : [document.querySelector('.git-diff-scroll')];
          return scrollers.map(scroller => {
            scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth;
            const edge = scroller.getBoundingClientRect().left + scroller.clientLeft + scroller.clientWidth;
            const rows = [...scroller.querySelectorAll('.git-code-cell.added, .git-code-cell.removed, h4')];
            return { scrolled: scroller.scrollLeft > 0, rows: rows.length,
              covered: rows.every(row => row.getBoundingClientRect().right >= edge - 1) };
          });
        });
        for (const background of backgrounds) {
          assert.ok(background.scrolled, `${width}/${split}: fixture must overflow horizontally`);
          assert.ok(background.rows > 0, `${width}/${split}: fixture must contain colored rows`);
          assert.ok(background.covered, `${width}/${split}: row backgrounds stop before the scrolled right edge`);
        }
        await page.locator('.git-diff-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
        await page.screenshot({ path:path.join(output, `${width}-${split ? 'split' : 'unified'}.png`) });
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
  console.log(`Screenshots: ${output}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
