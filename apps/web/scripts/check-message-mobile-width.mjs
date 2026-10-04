// Render the real message component and styles without starting the app server.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ChatMessageBubble from '../src/components/ChatMessageBubble.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workstep-message-width-'))
const h = React.createElement
const markup = renderToStaticMarkup(h(I18nProvider, null,
  h('div', { className: 'chat-history-scroll task-chat-history-scroll' },
    h('div', { className: 'chat-history-content task-conversation-content' },
      ...['assistant', 'user'].map(role => h(ChatMessageBubble, {
        key: role, role, sender: role === 'user' ? '谢测试1' : '需求分析与编写阶段',
        initials: role === 'user' ? '谢测' : '需求', color: '#136bff',
        content: '这里是一条足够长的对话消息，用来检查移动端显示头像后，正文和头像仍能完整排列。',
        header: role === 'user' ? h('span', null, '@编写 · 谢测试1 · 23:36') : undefined,
      })),
    ),
  ),
))
const css = ['index.css', 'mobile.css'].map(file => fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')).join('\n')
const file = path.join(dir, 'preview.html')
fs.writeFileSync(file, `<!doctype html><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}\nbody{margin:0}</style>${markup}`)
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
    await call('Page.navigate', { url: `file://${file}` }, sessionId)
    await new Promise(resolve => setTimeout(resolve, 250))
    const { result } = await call('Runtime.evaluate', { returnByValue: true, expression: `(() => {
      const measure = () => [...document.querySelectorAll('.chat-bubble')].map(e => e.getBoundingClientRect().width);
      const actual = measure();
      const avatars = [...document.querySelectorAll('.chat-message-avatar-anchor')].map(e => {
        const box = e.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width };
      });
      const baselineStyle = document.createElement('style');
      baselineStyle.textContent = '.task-conversation-content .chat-message-avatar-anchor { display: none !important; }';
      document.head.appendChild(baselineStyle);
      const baseline = measure(); baselineStyle.remove();
      return {actual, baseline, avatars, overflow: document.documentElement.scrollWidth > innerWidth};
    })()` }, sessionId)
    const measurements = result.result.value
    assert.deepEqual(measurements.actual, measurements.baseline, `${width}px: avatars must not reduce message width`)
    assert.equal(measurements.overflow, false, `${width}px: no horizontal overflow`)
    for (const avatar of measurements.avatars) {
      assert.equal(avatar.width, 32, `${width}px: task conversation avatars stay visible`)
      assert.ok(avatar.left >= 0 && avatar.right <= width, `${width}px: avatars stay within the viewport`)
    }
    const screenshot = await call('Page.captureScreenshot', { format: 'png' }, sessionId)
    fs.writeFileSync(path.join(dir, `${width}.png`), Buffer.from(screenshot.result.data, 'base64'))
    console.log(`${width}px: visible task avatars, no overflow`)
  }
  console.log(`Screenshots: ${dir}`)
} finally {
  clearTimeout(timeout)
  await call('Browser.close')
  browser.kill()
}
