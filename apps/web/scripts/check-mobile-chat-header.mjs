// Render the mobile navigation header without starting the app server.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workstep-mobile-chat-header-'))
const bundle = await build({
  stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { MemoryRouter } from 'react-router-dom';
    import ResponsiveNavigation from './src/components/ResponsiveNavigation';
    import MobileHeaderActions, { MobileHeaderActionsProvider } from './src/components/MobileHeaderActions';
    import { NavigationHeaderContext } from './src/components/NavigationHeaderContext';
    import ChatSessionLinkButton from './src/components/ChatSessionLinkButton';
    import Icon from './src/components/Icon';
    import { I18nProvider } from './src/i18n';
    window.WorkStepAndroid = { postMessage() {} };
    function Preview() {
      const [ready, setReady] = React.useState(false);
      window.setActionsReady = setReady;
      return <I18nProvider><MemoryRouter><MobileHeaderActionsProvider>
      <NavigationHeaderContext.Provider value={<button aria-label="切换设备"><Icon name="layers" size={20}/></button>}>
        <ResponsiveNavigation title="这是一段很长的对话标题用于检查分享按钮是否被挤出" onNew={() => {}}><span>模拟项目</span></ResponsiveNavigation>
        {ready && <MobileHeaderActions beforeNew={<ChatSessionLinkButton projectName="demo" sessionId="demo" mobile/>}>
          <button className="mobile-session-kebab" aria-label="会话菜单"><Icon name="ellipsis" size={20}/></button>
        </MobileHeaderActions>}
      </NavigationHeaderContext.Provider>
    </MobileHeaderActionsProvider></MemoryRouter></I18nProvider>;
    }
    createRoot(document.getElementById('root')).render(<Preview/>);
  `, resolveDir: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), loader: 'tsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  loader: { '.css': 'empty' },
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
    const centerBefore = await call('Runtime.evaluate', { returnByValue: true, expression: `(() => { const b = document.querySelector('.mobile-header-title').getBoundingClientRect(); return b.left + b.width / 2; })()` }, sessionId)
    assert.ok(Math.abs(centerBefore.result.result.value - width / 2) < 1, `${width}px: title is centered before session actions load`)
    await call('Runtime.evaluate', { expression: 'window.setActionsReady(true)' }, sessionId)
    await new Promise(resolve => setTimeout(resolve, 100))
    const { result } = await call('Runtime.evaluate', { returnByValue: true, expression: `(() => {
      const box = selector => { const b = document.querySelector(selector).getBoundingClientRect(); return { left: b.left, right: b.right, height: b.height }; };
      return { titleCenter: (() => { const b = document.querySelector('.mobile-header-title').getBoundingClientRect(); return b.left + b.width / 2; })(), order: [...document.querySelectorAll('.mobile-header-actions button')].map(b => b.getAttribute('aria-label')), left: box('.mobile-header-left'), title: box('.mobile-header-title'), actions: box('.mobile-header-actions'),
        buttons: [...document.querySelectorAll('.mobile-header button')].map(button => { const b = button.getBoundingClientRect(); return { left: b.left, right: b.right, hit: button.contains(document.elementFromPoint(b.x + b.width/2, b.y + b.height/2)) }; }) };
    })()` }, sessionId)
    const m = result.result.value
    assert.ok(m.left.right <= m.title.left && m.title.right <= m.actions.left, `${width}px: title and controls do not overlap: ${JSON.stringify(m)}`)
    assert.ok(Math.abs(m.titleCenter - width / 2) < 1, `${width}px: title stays centered on the viewport: ${JSON.stringify(m)}`)
    assert.match(m.order[0], /复制|分享/)
    assert.match(m.order[1], /新建/)
    assert.equal(m.buttons.length, 5)
    for (const button of m.buttons) assert.ok(button.left >= 0 && button.right <= width && button.hit, `${width}px: every header button is visible and clickable`)
    for (const button of m.buttons.slice(2)) assert.ok(button.left >= m.title.right, `${width}px: action buttons stay outside the title`)
    const screenshot = await call('Page.captureScreenshot', { format: 'png' }, sessionId)
    fs.writeFileSync(path.join(dir, `${width}.png`), Buffer.from(screenshot.result.data, 'base64'))
    console.log(`${width}px: title remains centered before/after loading; share precedes plus; controls remain clickable`)
  }
  console.log(`Screenshots: ${dir}`)
} finally {
  clearTimeout(timeout)
  await call('Browser.close')
  browser.kill()
}
