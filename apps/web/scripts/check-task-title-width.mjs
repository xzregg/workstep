// Render and edit the real task header without starting the app server.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workstep-task-title-width-'))
const bundle = await build({
  stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import TaskDetailHeader from './src/components/TaskDetailHeader';
    import { I18nProvider } from './src/i18n';
    createRoot(document.getElementById('root')).render(<I18nProvider><TaskDetailHeader
      task={{ id: 'demo', title: '20260915-zt-21073-长任务名称用于验证标题布局', status: 'paused', steps: [], creator_name: '演示用户', created_at: '2026-09-17T18:51:19Z' }}
      projectId="demo" titleEditable locale="zh-CN" activeStep={{ label: '验收' }} activeStepColor="#d97706" taskCompleted={false}
      headerActions={<><button>已绑定 BOT</button><button>分享</button><button>任务 ID</button></>}
      onClose={() => { window.closeClicks = (window.closeClicks || 0) + 1 }} /> </I18nProvider>);
  `, resolveDir: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), loader: 'tsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
})
const css = ['index.css', 'mobile.css'].map(file => fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')).join('\n')
const file = path.join(dir, 'preview.html')
fs.writeFileSync(file, `<!doctype html><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}\nbody{margin:0}</style><div id="root"></div><script>${bundle.outputFiles[0].text}</script>`)
const browser = spawn(process.env.CHROME_BINARY || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${path.join(dir, 'chrome')}`, '--remote-debugging-pipe'],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
let sequence = 0
let buffer = ''
const pending = new Map()
browser.stdio[4].on('data', data => {
  buffer += data
  let end
  while ((end = buffer.indexOf('\0')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    if (message.id) {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    }
  }
})
const call = (method, params = {}, sessionId) => new Promise(resolve => {
  const id = ++sequence
  pending.set(id, resolve)
  browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0')
})
const timeout = setTimeout(() => browser.kill(), 30000)
try {
  const { result: { targetId } } = await call('Target.createTarget', { url: 'about:blank' })
  const { result: { sessionId } } = await call('Target.attachToTarget', { targetId, flatten: true })
  for (const width of [320, 390, 1023]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId)
    await call('Emulation.setTouchEmulationEnabled', { enabled: true }, sessionId)
    await call('Page.navigate', { url: `file://${file}` }, sessionId)
    await new Promise(resolve => setTimeout(resolve, 250))
    for (const editing of [false, true]) {
      if (editing) await call('Runtime.evaluate', { expression: `document.querySelector('[data-task-title]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))` }, sessionId)
      await new Promise(resolve => setTimeout(resolve, 50))
      const { result } = await call('Runtime.evaluate', { returnByValue: true, expression: `(() => {
        const box = selector => { const b = document.querySelector(selector).getBoundingClientRect(); return { left: b.left, right: b.right, height: b.height, top: b.top, bottom: b.bottom } };
        const close = document.querySelector('.task-detail-header-close');
        const b = close.getBoundingClientRect();
        const hit = (x, y) => close.contains(document.elementFromPoint(x, y));
        return { overflow: document.documentElement.scrollWidth > innerWidth, title: box('.task-detail-title'), meta: box('.task-detail-header-meta'), actions: box('.task-detail-header-actions'), input: document.querySelector('input') ? box('input') : null,
          close: box('.task-detail-header-close'), closeHit: hit(b.left + 2, b.top + 2) && hit(b.right - 2, b.bottom - 2) };
      })()` }, sessionId)
      const m = result.result.value
      assert.equal(m.overflow, false, `${width}px: no horizontal overflow`)
      for (const box of [m.title, m.meta, m.actions]) assert.ok(box.left >= 0 && box.right <= width && box.height > 0, `${width}px: header fields remain visible`)
      assert.equal(Boolean(m.input), editing)
      if (editing) assert.equal(m.input.height, 32, `${width}px: regular control height`)
      assert.ok(m.actions.top < m.meta.bottom, `${width}px: actions stay beside creator and date`)
      assert.equal(m.close.right - m.close.left, 44, `${width}px: close touch width`)
      assert.equal(m.close.height, 44, `${width}px: close touch height`)
      assert.ok(m.closeHit, `${width}px: close touch area is not covered`)
      assert.ok(m.close.left >= 0 && m.close.right <= width, `${width}px: close remains in viewport`)
      const x = m.close.right - 3
      const y = m.close.top + 3
      await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }, sessionId)
      await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId)
      const clickCount = await call('Runtime.evaluate', { expression: 'window.closeClicks', returnByValue: true }, sessionId)
      assert.equal(clickCount.result.result.value, editing ? 2 : 1, `${width}px: edge tap fires close once`)
    }
    const screenshot = await call('Page.captureScreenshot', { format: 'png' }, sessionId)
    fs.writeFileSync(path.join(dir, `${width}.png`), Buffer.from(screenshot.result.data, 'base64'))
    console.log(`${width}px: title display and editing: two header rows, no overflow`)
  }
  console.log(`Screenshots: ${dir}`)
} finally {
  clearTimeout(timeout)
  await call('Browser.close')
  browser.kill()
}
