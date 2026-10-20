// Real Chrome layout checks for the shared task coordinator composer; no app server.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ChatInput from '../src/components/ChatInput.tsx'
import TaskChatTargetTabs from '../src/components/TaskChatTargetTabs.tsx'
import PendingMessageInserts from '../src/components/PendingMessageInserts.tsx'
import { I18nProvider, useLocaleStore, zhCNT } from '../src/i18n/index.tsx'
const h = React.createElement
useLocaleStore.setState({locale:'zh-CN'})
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'workstep-coordinator-layout-'))
const css = ['index.css','mobile.css'].map(file=>fs.readFileSync(new URL(`../src/${file}`,import.meta.url),'utf8')).join('\n')
const files = new Map()
for (const [name,value,stopping] of [['running','',false],['draft','请按最新要求继续',false],['stopping','',true]]) {
 const markup = renderToStaticMarkup(h(I18nProvider,null,
  h('main', {className:'task-detail-chat'},
   h(TaskChatTargetTabs,{target:'coordinator',steps:[{key:'review',label:'复盘上周效果'},{key:'marketing',label:'切分支实施本周优化'}],stepProgress:[],runningStepKeys:['marketing'],resumableTarget:null}),
   h(PendingMessageInserts,{items:[{id:'demo',content:'用 CLI 检查流程能否优化。'}],title:'待插入消息',titleTooltip:'本轮结束后发送',onSend:()=>{}}),
   h(ChatInput,{value,running:true,allowSendWhileRunning:true,stopping,onSend:()=>{},onChange:()=>{},onStop:()=>{},placeholder:zhCNT('taskDetail.coordinatorProcessing')}))))
 const file=path.join(dir,`${name}.html`)
 fs.writeFileSync(file,`<!doctype html><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}\nbody{margin:0}main{padding:8px;min-width:0;box-sizing:border-box}.pending-insert-panel{position:relative;inset:auto;transform:none;width:100%;max-width:100%;box-sizing:border-box}.task-detail-chat{display:flex;flex-direction:column;gap:8px;width:100%}</style>${markup}`)
 files.set(name,file)
}
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
const timeout = setTimeout(()=>browser.kill(),30000)
try {
 const {result:{targetId}}=await call('Target.createTarget',{url:'about:blank'})
 const {result:{sessionId}}=await call('Target.attachToTarget',{targetId,flatten:true})
 for (const [name,file] of files) for (const width of [320,390,1023,1440]) {
  await call('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<=1023},sessionId)
  await call('Page.navigate',{url:`file://${file}`},sessionId)
  await new Promise(resolve=>setTimeout(resolve,150))
  const {result}=await call('Runtime.evaluate',{returnByValue:true,expression:`(() => {
   const buttons=[...document.querySelectorAll('.chat-input-send')]; const button=buttons[0];
   const rect=button.getBoundingClientRect();
   return {overflow:document.documentElement.scrollWidth>innerWidth,count:buttons.length,label:button.getAttribute('aria-label'),disabled:button.disabled,width:rect.width,height:rect.height,left:rect.left,right:rect.right,display:getComputedStyle(button).display};
  })()`},sessionId)
  const measured=result.result.value
  assert.equal(measured.overflow,false,`${name} ${width}px overflow`)
  assert.equal(measured.count,1)
  assert.equal(measured.label,name==='draft'?'发送':name==='stopping'?'停止中…':'停止')
  assert.equal(measured.disabled,name==='stopping')
  assert.ok(measured.left>=0 && measured.right<=width)
  assert.ok(measured.width>0 && measured.height>0,`${name} ${width}px ${JSON.stringify(measured)}`)
  if (width<=1023) assert.ok(measured.width>=32 && measured.height>=32,`${name} ${width}px ${JSON.stringify(measured)}`)
  assert.notEqual(measured.display,'none')
  if (width===390) {
   const {result:shot}=await call('Page.captureScreenshot',{format:'png'},sessionId)
   fs.writeFileSync(path.join(dir,`${name}-${width}.png`),Buffer.from(shot.data,'base64'))
  }
 }
 console.log(`12 Chrome layout checks passed; screenshots: ${dir}`)
} finally {clearTimeout(timeout);browser.kill()}
