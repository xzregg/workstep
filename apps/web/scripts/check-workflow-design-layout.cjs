// Render real components with public demo text; no app server or user project.
const { buildSync } = require('esbuild');
const { chromium } = require('../../desktop/node_modules/playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'workstep-workflow-design-'));
buildSync({
  stdin: { contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {MemoryRouter} from 'react-router-dom';
    import {I18nProvider,useLocaleStore} from './src/i18n';
    import ChatInput from './src/components/ChatInput';
    import MarkdownContent from './src/components/MarkdownContent';
    import {useWorkflowDesignSkill} from './src/hooks/useWorkflowDesignSkill';
    import {engineApi} from './src/api/client';
    import './src/index.css';
    import './src/mobile.css';
    useLocaleStore.getState().setLocale('zh-CN');
    engineApi.inspect = async () => ({input_items:[{kind:'skill',name:'workstep-exec',insert_text:'$workstep-exec ',action:'prompt'}]});
    function App() {
      const [input,setInput]=useState('制作一个文件整理工具');
      const skill=useWorkflowDesignSkill({projectId:'demo',engine:'codex',sessionId:'demo-chat',input,onChange:setInput,running:false,onError:console.error});
      return <main className="workflow-design-fixture"><div className="workflow-design-result">
        <MarkdownContent projectId="demo" mermaidRenderDelayMs={0} content={'先分析文件分类规则，再实现整理工具，最后验证结果。\\n\\n'+
          '\\x60\\x60\\x60mermaid\\nflowchart LR\\n A["分析规则"] --> B["实现工具"]\\n B --> C["验证结果"]\\n\\x60\\x60\\x60\\n\\n'+
          '[打开任务详情](workstep-task://open?project_id=demo&task_id=demo-task)'} />
        </div><ChatInput value={input} onChange={setInput} onSend={()=>{}} workflowSkill={skill}/></main>;
    }
    createRoot(document.getElementById('root')).render(<I18nProvider><MemoryRouter><App/></MemoryRouter></I18nProvider>);
  `, loader: 'tsx', resolveDir: path.resolve(__dirname, '..') },
  bundle: true, outfile: path.join(output, 'fixture.js'), format: 'iife', jsx: 'automatic',
  define: { 'import.meta.env.DEV': 'false' }, logLevel: 'error',
});
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [320, 390, 1023, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width <= 1023 });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('http://workflow-layout.test/**', route => route.fulfill({ contentType: 'text/html', body: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>' }));
      await page.goto('http://workflow-layout.test/');
      await page.addStyleTag({ path: path.join(output, 'fixture.css') });
      await page.addStyleTag({ content: '.workflow-design-fixture{padding:12px;max-width:850px;margin:auto;min-width:0}.workflow-design-result{margin-bottom:20px}body{overflow:auto}' });
      await page.addScriptTag({ path: path.join(output, 'fixture.js') });
      await page.locator('.markdown-task-link').waitFor();
      await page.locator('.mermaid-block svg.flowchart').waitFor();
      await page.locator('.chat-input-attach').click();
      await page.getByRole('button', { name: '流程模式', exact: true }).click();
      await page.locator('[data-kind="workflow-skill"]').waitFor();
      assert.equal(await page.locator('textarea').inputValue(), '$workstep-exec 制作一个文件整理工具');
      const metrics = await page.evaluate(() => {
        const rect = selector => { const r=document.querySelector(selector).getBoundingClientRect(); return {x:r.x,right:r.right,width:r.width,height:r.height}; };
        return {overflow:document.documentElement.scrollWidth>innerWidth,pill:rect('[data-kind="workflow-skill"]'),task:rect('.markdown-task-link'),diagram:rect('.mermaid-block')};
      });
      assert.equal(metrics.overflow, false, width + ': horizontal overflow');
      assert.ok(metrics.pill.right <= width, width + ': mode pill clipped');
      assert.ok(metrics.task.right <= width, width + ': task button clipped');
      assert.ok(metrics.task.width >= 90, width + ': task label compressed into icon width');
      assert.ok(metrics.diagram.right <= width, width + ': diagram clipped');
      assert.deepEqual(errors, []);
      await page.screenshot({ path: path.join(output, width + '.png') });
      console.log(JSON.stringify({width,metrics}));
      await page.close();
    }
  } finally { await browser.close(); }
  console.log('Screenshots: ' + output);
})().catch(error => { console.error(error); process.exitCode=1; });
