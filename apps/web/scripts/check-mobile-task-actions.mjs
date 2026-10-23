// Render the real mobile task menu without starting the application.
import { installDomEnvironment } from '../tests/helpers/domEnv.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import MobileTaskRow from '../src/components/MobileTaskRow.tsx'
import { I18nProvider, useLocaleStore } from '../src/i18n/index.tsx'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workstep-mobile-task-actions-'))
const { window } = installDomEnvironment()
Object.assign(globalThis,{history:window.history})
useLocaleStore.setState({locale:'zh-CN'})
const root=createRoot(document.body.appendChild(document.createElement('div')))
const noop=()=>{}
await act(async()=>root.render(React.createElement(I18nProvider,null,React.createElement(MobileTaskRow,{
 title:'操作手册演示：移动端任务操作与长标题换行验证', status:'ready', archived:false,
 canStart:true, canArchive:true, canDelete:true, projectId:'demo', taskId:'demo-task',
 onOpen:noop, onStart:noop, onArchive:noop, onRestore:noop, onDelete:noop,
}, '操作手册演示'))))
await act(async()=>document.querySelector('.mobile-task-row').dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true})))
const markup=document.querySelector('.mobile-sheet-backdrop').outerHTML
const css=['index.css','mobile.css','components/TaskCopyButton.css'].map(file=>fs.readFileSync(new URL(`../src/${file}`,import.meta.url),'utf8')).join('\n')
const file=path.join(dir,'menu.html')
fs.writeFileSync(file,`<!doctype html><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>${markup}`)
await act(async()=>root.unmount())
await window.happyDOM.close()
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
  for (const width of [320,390,1023]) {
    await call('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true},sessionId)
    await call('Page.navigate',{url:`file://${file}`},sessionId)
    await new Promise(resolve=>setTimeout(resolve,250))
    const {result}=await call('Runtime.evaluate',{returnByValue:true,expression:`(() => {
      const buttons=[...document.querySelectorAll('.mobile-task-menu > button')];
      return {overflow:document.documentElement.scrollWidth>innerWidth,buttons:buttons.map(button=>{
        const r=button.getBoundingClientRect();return {text:button.textContent,left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,icon:button.querySelector('svg').getBoundingClientRect().width};
      })};
    })()`},sessionId)
    const measured=result.result.value
    assert.equal(measured.overflow,false)
    assert.equal(measured.buttons.length,5)
    for(const button of measured.buttons){
      assert.ok(button.left>=0 && button.right<=width)
      assert.ok(button.top>=0 && button.bottom<=844)
      assert.ok(button.height>=32)
      assert.ok(button.icon>=16)
    }
    const screenshot=await call('Page.captureScreenshot',{format:'png'},sessionId)
    fs.writeFileSync(path.join(dir,`${width}.png`),Buffer.from(screenshot.result.data,'base64'))
    console.log(`${width}px: five actions visible, no overflow`)
  }
  console.log(`Screenshots: ${dir}`)
} finally {
  clearTimeout(timeout)
  await call('Browser.close')
  browser.kill()
}
