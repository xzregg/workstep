// Isolated production components with explicitly simulated task data.
import { installDomEnvironment } from '../tests/helpers/domEnv.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import MobileTaskSelection from '../src/components/MobileTaskSelection.tsx'
import MobileTaskRow from '../src/components/MobileTaskRow.tsx'
import { MemoryRouter } from 'react-router-dom'
import TaskList from '../src/pages/TaskList.tsx'
import { useProjectStore } from '../src/stores/projectStore.ts'
import { useManagedModeStore } from '../src/stores/managedModeStore.ts'
import { scheduleApi } from '../src/api/client.ts'
import { useTaskStore } from '../src/stores/taskStore.ts'
import TaskTableView from '../src/components/TaskTableView.tsx'
import { I18nProvider, useLocaleStore } from '../src/i18n/index.tsx'
const dir=path.resolve('../../tmp/mobile-task-multiselect/render')
fs.mkdirSync(dir,{recursive:true})
const {window}=installDomEnvironment()
Object.assign(globalThis,{history:window.history})
const container=document.body.appendChild(document.createElement('div'))
const root=createRoot(container)
const tasks=Array.from({length:12},(_,i)=>({id:String(i),title:i===0?'模拟任务：任务看板长标题和安全区验证，保持完整内容可读':'模拟任务 '+i,status:'ready',created_at:'2026-11-27T12:00:00Z',updated_at:'2026-11-27T12:00:00Z',steps:[]}))
const noop=()=>{}
const actions={canArchive:true,canDelete:true,canCleanWorkspace:true,onArchiveTask:async()=>{},onDeleteTask:async()=>{},onError:noop}
const css=['index.css','mobile.css','components/MobileTaskSelection.css','components/TaskCopyButton.css','components/ConfirmDialog.css'].map(file=>fs.readFileSync(new URL('../src/'+file,import.meta.url),'utf8')).join('\n')
for(const state of ['normal','selected','archived','selected-en','empty','confirm','busy','desktop','menu-active','menu-archived','normal-archived','copy-busy','copy-error','multiple','none-selected','page']) {
  await act(async()=>useLocaleStore.setState({locale:state==='selected-en'?'en-US':'zh-CN'}))
  useTaskStore.setState({copyTask:state==='copy-error'?async()=>{throw new Error('模拟复制失败')}:()=>new Promise(()=>{})})
  const archived=['archived','menu-archived','normal-archived'].includes(state)
  const list=state==='empty'?[]:tasks
  if(state==='page') {
    window.matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){}})
    scheduleApi.list=async()=>({schedules:[]})
    useProjectStore.setState({activeProject:{id:'demo',name:'模拟项目',path:'/demo',steps:{},workflows:[{id:'flow',name:'任务看板'}]},activeWorkflowId:'flow'})
    useTaskStore.setState({tasks:tasks.map(t=>({...t,workflow_id:'flow'})),loading:false,listQuery:{projectId:'demo',workflowId:'flow',archived:false},fetchTasks:async()=>{}})
    useManagedModeStore.setState({load:async()=>{}})
  }
  await act(async()=>root.render(React.createElement(I18nProvider,null,
    state==='page'?React.createElement(MemoryRouter,null,React.createElement(TaskList)):
    state==='desktop'?React.createElement(TaskTableView,{...actions,lanes:[{key:'todo',label:'待办',color:'blue'}],tasksByLane:{todo:tasks},showArchived:false,durationNowMs:0,onOpenTask:noop,onAddTask:noop}):
    React.createElement(MobileTaskSelection,{...actions,key:state,projectId:'demo',tasks:list,showArchived:archived,onArchiveTask:state==='busy'?()=>new Promise(()=>{}):actions.onArchiveTask},
      selection=>React.createElement('div',{className:'mobile-task-list'},list.map(task=>
        React.createElement(MobileTaskRow,{key:task.id,taskId:task.id,title:task.title,status:task.status,archived,
          canArchive:true,canDelete:true,canStart:true,onStart:noop,projectId:'demo',onOpen:noop,onArchive:noop,onRestore:noop,onDelete:noop,
          selectionMode:selection.active,selected:selection.selectedIds.includes(task.id),
          onSelect:()=>selection.select(task.id)},
          React.createElement('span',{className:'mobile-task-row-title'},task.title),
          React.createElement('span',{className:'mobile-task-row-meta'},'待办 · 谢钊荣 · 开发',React.createElement('time',null,'11/27 20:00')))))))))
  if(!['normal','empty','desktop','menu-active','menu-archived','normal-archived','page'].includes(state)) {
    const row=container.querySelector('.mobile-task-row')
    await act(async()=>{
      row.dispatchEvent(new window.PointerEvent('pointerdown',{bubbles:true,pointerType:'touch',button:0}))
      await new Promise(resolve=>setTimeout(resolve,520))
      row.dispatchEvent(new window.PointerEvent('pointerup',{bubbles:true}));row.click()
    })
    if(state==='confirm'||state==='busy') await act(async()=>container.querySelector('.mobile-task-bulk-actions [data-task-action="archive"]').click())
  }
  if(state==='none-selected') await act(async()=>container.querySelector('.mobile-task-row').click())
  if(state==='multiple') await act(async()=>container.querySelectorAll('.mobile-task-row')[1].click())
  if(state.startsWith('copy-')) await act(async()=>container.querySelector('.mobile-task-bulk-actions [data-task-action="copy"]').click())
  if(state.startsWith('menu-')) await act(async()=>container.querySelector('.mobile-task-row').dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true})))
  if(state==='busy') await act(async()=>container.querySelector('.confirm-dialog-confirm').click())
  fs.writeFileSync(path.join(dir,state+'.html'),`<!doctype html><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}
  .fixture{height:100dvh;display:flex;flex-direction:column;overflow:hidden}
  </style><div class="fixture">${container.innerHTML}</div>${document.querySelector('.mobile-sheet-backdrop')?.outerHTML || ''}`)
}
await act(async()=>root.unmount())
await window.happyDOM.close()
const measurements=[]
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
  for (const [state,width,scale] of [['none-selected',390,1],['page',320,1],['page',390,1],['page',1023,1],['copy-busy',320,1],['copy-error',390,1],['multiple',320,1],['menu-active',320,1],['menu-active',390,1],['menu-active',1023,1],['menu-archived',320,1],['menu-archived',390,1],['normal-archived',390,1],['normal',320,1.3],['normal',1023,1],['normal',320,1],['normal',390,1],['selected',320,1],['selected',390,1],['selected',1023,1],['archived',320,1],['archived',390,1],['selected',320,1.3],['selected-en',320,1.3],['empty',390,1],['confirm',390,1],['busy',390,1],['desktop',1024,1],['desktop',1440,1]]) {
    const file=path.join(dir,state+'.html')
    await call('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true},sessionId)
    await call('Page.navigate',{url:`file://${file}`},sessionId)
    await new Promise(resolve=>setTimeout(resolve,250))
    await call('Runtime.evaluate',{expression:`document.documentElement.style.setProperty('--font-scale','${scale}')`},sessionId)
    const safeArea=await call('Emulation.setSafeAreaInsetsOverride',{insets:{bottom:34}},sessionId)
    assert.ok(!safeArea.error, JSON.stringify(safeArea.error))
    const {result}=await call('Runtime.evaluate',{returnByValue:true,expression:`(() => {
      const list=document.querySelector('.mobile-task-list'); if(list) list.scrollTop=list.scrollHeight;
      const footer=document.querySelector('.mobile-task-bulk-actions');
      const rect=el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height}};
      return {overflow:document.documentElement.scrollWidth>innerWidth,
        rowMore:document.querySelectorAll('.mobile-task-row-more').length,topMore:document.querySelectorAll('.mobile-task-toolbar .mobile-toolbar-icon-button').length,
        footer:footer?{...rect(footer),padding:getComputedStyle(footer).paddingBottom}:null,
        last:list?.lastElementChild?rect(list.lastElementChild):null,
        buttons:[...document.querySelectorAll('.mobile-task-selection-header>button,.mobile-task-bulk-actions>button,.mobile-task-row-more,.mobile-task-menu>button')]
        .map(b=>{
          const r=b.getBoundingClientRect(), pseudo=getComputedStyle(b,'::before');
          const compact=b.matches('.mobile-task-selection-header>button,.mobile-task-bulk-actions>button');
          const hitHeight=compact?parseFloat(pseudo.height):r.height;
          const hits=compact&&!document.querySelector('[role="dialog"]')?
            [-5,r.height+5].every(y=>document.elementFromPoint(r.left+r.width/2,r.top+y)===b):true;
          const content=[...b.childNodes].filter(n=>n.nodeType===1||n.textContent.trim()).map(n=>{
            if(n.nodeType===1) return n.getBoundingClientRect();
            const range=document.createRange();range.selectNodeContents(n);return range.getBoundingClientRect();
          }).filter(r=>r.width>0&&r.height>0);
          const left=Math.min(...content.map(c=>c.left)),right=Math.max(...content.map(c=>c.right));
          const top=Math.min(...content.map(c=>c.top)),bottom=Math.max(...content.map(c=>c.bottom));
          return {...rect(b),hitHeight,hits,centerX:Math.abs((left+right-r.left-r.right)/2),centerY:Math.abs((top+bottom-r.top-r.bottom)/2),overflow:getComputedStyle(b).overflow,
            targets:[-5,r.height+5].map(y=>document.elementFromPoint(r.left+r.width/2,r.top+y)?.className),
            compact:b.matches('.mobile-task-selection-header>button,.mobile-task-bulk-actions>button'),text:b.textContent,minimum:b.matches('.mobile-task-menu>button')?32:44,clipped:left<r.left||right>r.right||top<r.top||bottom>r.bottom,lineHeight:getComputedStyle(b).lineHeight,icon:b.querySelector('svg')?.getBoundingClientRect().width}})};
    })()`},sessionId)
    const measured=result.result.value
    assert.equal(measured.overflow,false)
    assert.equal(measured.rowMore,0)
    if(state==='page') assert.equal(measured.topMore,1)
    for(const button of measured.buttons) {
      assert.ok(button.left>=0 && button.right<=width)
      if(button.compact) {
        assert.equal(button.height,32)
        assert.ok(button.hitHeight>=44)
        assert.ok(button.centerX<=1)
        assert.ok(button.centerY<=1)
        assert.equal(button.hits,true,JSON.stringify(button))
      }
      else assert.ok(button.height>=button.minimum)
      assert.equal(button.clipped,false)
    }
    if(measured.footer) {
      assert.ok(measured.last.bottom<=measured.footer.top)
      assert.ok(measured.footer.bottom<=844)
      assert.ok(parseFloat(measured.footer.padding)>=34)
    }
    measurements.push({state,width,scale,...measured})
    const screenshot=await call('Page.captureScreenshot',{format:'png'},sessionId)
    fs.writeFileSync(path.join(dir,`${state}-${width}-${scale}.png`),Buffer.from(screenshot.result.data,'base64'))
    await call('Runtime.evaluate',{expression:"document.querySelector('.mobile-task-list')?.scrollTo(0,0)"},sessionId)
    const top=await call('Page.captureScreenshot',{format:'png'},sessionId)
    fs.writeFileSync(path.join(dir,`${state}-${width}-${scale}-top.png`),Buffer.from(top.result.data,'base64'))
    console.log(`${state} ${width}px scale ${scale}: passed`)
  }
  for(const [state,width] of [['copy-busy',320],['busy',390]]) {
    const idle=measurements.find(m=>m.state==='selected'&&m.width===width&&m.scale===1)
    const loading=measurements.find(m=>m.state===state&&m.width===width)
    assert.equal(loading.footer.height,idle.footer.height,'loading must not add a button row')
  }
  fs.writeFileSync(path.join(dir,'measurements.json'),JSON.stringify(measurements,null,2))
  console.log(`Screenshots: ${dir}`)
} finally {
  clearTimeout(timeout)
  await call('Browser.close')
  browser.kill()
}
