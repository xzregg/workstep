// Render both real schedule forms and measure them in Chrome without an app server.
import { installDomEnvironment } from '../tests/helpers/domEnv.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import SchedulePage from '../src/pages/SchedulePage.tsx'
import { scheduleApi, workflowApi } from '../src/api/client.ts'
import { useProjectStore } from '../src/stores/projectStore.ts'
import { renderToStaticMarkup } from 'react-dom/server'
import TaskScheduleEditor from '../src/components/TaskScheduleEditor.tsx'
import TaskSchedules from '../src/components/TaskSchedules.tsx'
import ChatInput from '../src/components/ChatInput.tsx'
import TaskDetailTabs from '../src/components/TaskDetailTabs.tsx'
import { useLocaleStore, I18nProvider } from '../src/i18n/index.tsx'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workstep-task-schedule-layout-'))
const h = React.createElement
useLocaleStore.setState({ locale: 'zh-CN' })
const schedule = { id:'demo-rule', name:'每十分钟汇报', target_type:'task', target_task_id:'demo-task',
  notification:{enabled:true,target:{bot_id:'demo',group_id:'demo'}},
  instruction:'总结整个任务的进度、阻塞与下一步，并使用 CLI 发送到指定绑定群。', stop_condition:'manual',
  rule:{ kind:'minutes', every:10, timezone:'Asia/Shanghai' } }
const markup = renderToStaticMarkup(h(I18nProvider, null,
  h('div', { className:'schedule-page schedule-page--editing schedule-page--creating' },
    h('div', { className:'schedule-layout' },
      h('main', { className:'schedule-editor' },
        h('h2', null, '任务协调指令'),
        h(TaskScheduleEditor, { projectId:'demo-project', schedule, onSaved:() => {} }),
      ),
    ),
  ),
))
const css = ['index.css', 'mobile.css', 'pages/SchedulePage.css', 'components/TaskSchedules.css', 'components/TaskScheduleEditor.css', 'components/ScheduleRuleEditor.css', 'components/TaskPicker.css', 'components/ScheduleNotificationEditor.css'].map(file => fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')).join('\n')
const { window } = installDomEnvironment()
const project = { id:'demo-project',name:'演示项目',path:'/tmp/demo',steps:{},workflows:[{id:'flow',name:'演示流程',nodeCount:0}] }
useProjectStore.setState({activeProject:project,projects:[project]})
scheduleApi.list = async () => ({schedules:[]})
scheduleApi.notificationOptions = async () => ({choices:[],default:{enabled:false}})
scheduleApi.preview = async () => ({next_runs:[],summary:'',timezone:'UTC',cron_expression:null})
workflowApi.get = async () => ({id:'flow',name:'演示流程',steps:{nodes:[]}})
const container = document.body.appendChild(document.createElement('div')), root=createRoot(container)
await act(async()=>root.render(h(MemoryRouter,null,h(I18nProvider,null,h(SchedulePage,{project})))))
await act(async()=>container.querySelector('.schedule-new-button').click())
// Serialize live select properties so the static layout matches the actual form.
for (const select of container.querySelectorAll('select')) {
  for (const option of select.options) option.toggleAttribute('selected',option.value===select.value)
}
const projectMarkup=container.innerHTML
assert.ok(container.querySelector('.schedule-rule-editor'),'project form uses the shared editor')
scheduleApi.list = async () => ({ schedules: [{ ...schedule,
  target_task_title:'操作手册演示：这是一个用于验证窄屏省略显示的很长的关联任务名称'.repeat(3),
  name:'今晚23点任务状态', creator_name:'演示创建人长姓名'.repeat(12), workflow_id:'', task_template:{}, status:'completed', next_run_at:null,
  rule:{kind:'once',run_at:'2026-10-16T23:00:00+08:00',timezone:'Asia/Shanghai'},
  summary:'Once at 2026-10-16T23:00:00+08:00',
}] })
await act(async()=>root.unmount())
const listRoot=createRoot(container)
await act(async()=>listRoot.render(h(MemoryRouter,null,h(I18nProvider,null,h(SchedulePage,{project})))))
await act(async()=>[...container.querySelectorAll('button')].find(button=>button.textContent==='一次性').click())
const listMarkup=container.innerHTML
assert.ok(container.querySelector('.schedule-task-target'))
scheduleApi.runs = async () => ({runs:[{
  id:'demo-batch', schedule_id:'demo-rule', status:'failed', reason:'演示：第三项创建失败，已创建的任务保留。',
  scheduled_for:'2026-10-16T23:00:00+08:00', task_id:'demo-1',
  created_tasks:[1,2,3,4,5].map(id=>({id:`demo-${id}`,title:`任务${id}：${'无空格长任务名称'.repeat(20)}`,workflow_id:'flow'})),
}]})
await act(async()=>container.querySelector('.schedule-list-item').click())
const batchRunsMarkup=container.innerHTML
assert.equal(container.querySelectorAll('.schedule-run-task-link').length,5)
await act(async()=>listRoot.unmount())
const entryRoot=createRoot(container)
const load=async()=>({schedules:[{
  id:'bound-rule',name:'每十分钟汇报当前任务进度',status:'active',rule:schedule.rule,
  summary:'每 10 分钟',instruction:schedule.instruction,
}]})
await act(async()=>entryRoot.render(h(I18nProvider,null,
  h(TaskDetailTabs, {className:'task-detail-primary-tabs',selected:'detail',onSelect:()=>{},
    tabs:[{id:'detail',label:'任务详情'},{id:'analysis',label:'执行分析'},{id:'git',label:'Git工作区'}],
    actions:h(React.Fragment,null,h(TaskSchedules,{taskId:'demo-task',load}),
      h('button',{className:'btn btn-ghost task-detail-discussion-button'},'绑定BOT'),
      h('button',{className:'btn btn-ghost task-detail-share-button','aria-label':'分享'},'↗')),
  }),
  h(ChatInput,{value:'',onChange:()=>{},onSend:()=>{},resetStep:{active:false,onChange:()=>{}}}),
)))
const entryMarkup=container.innerHTML
await act(async()=>container.querySelector('.task-schedules-trigger').click())
const taskSchedulesMarkup=document.querySelector('.task-schedules-overlay').outerHTML
await act(async()=>entryRoot.unmount())
const managedRoot=createRoot(container)
await act(async()=>managedRoot.render(h(MemoryRouter,null,h(I18nProvider,null,h(TaskSchedules,{
  taskId:'demo-task',load,project,task:{id:'demo-task',title:'当前任务',workflow_id:'flow'},
})))))
await act(async()=>container.querySelector('.task-schedules-trigger').click())
await act(async()=>[...document.querySelectorAll('button')].find(button=>button.textContent.includes('新建定时任务')).click())
const managedMarkup=document.querySelector('.task-schedules-overlay').outerHTML
assert.equal(document.querySelector('[aria-label="关联任务"]').value,'当前任务')
await act(async()=>managedRoot.unmount())
await window.happyDOM.close()
const files = new Map()
for (const [name,content] of [['task',markup],['project',projectMarkup],['list',listMarkup],['batchRuns',batchRunsMarkup],['entry',entryMarkup],['taskSchedules',taskSchedulesMarkup],['managed',managedMarkup]]) {
  const file=path.join(dir,`${name}.html`)
  fs.writeFileSync(file, `<!doctype html><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}\nbody{margin:0}.schedule-layout{display:grid;grid-template-columns:minmax(0,700px);justify-content:center}.schedule-editor{padding:18px;min-width:0}</style>${content}`)
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
const timeout = setTimeout(() => browser.kill(), 30000)
try {
  const { result: { targetId } } = await call('Target.createTarget', { url: 'about:blank' })
  const { result: { sessionId } } = await call('Target.attachToTarget', { targetId, flatten: true })
  for (const [name,file] of files) {
  for (const width of [320, 390, 1023, 1440]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId)
    await call('Page.navigate', { url: `file://${file}` }, sessionId)
    await new Promise(resolve => setTimeout(resolve, 250))
    const { result } = await call('Runtime.evaluate', { returnByValue:true, expression:`(() => {
      const fields = [...document.querySelectorAll('.schedule-editor input, .schedule-editor select, .schedule-editor textarea')].filter(field => field.getBoundingClientRect().width > 0);
      return { overflow:document.documentElement.scrollWidth > innerWidth,
        centered:[...document.querySelectorAll('.schedule-frequency-tabs button')].every(button=>getComputedStyle(button).justifyContent==='center'),
        fields:fields.map(field => {const r=field.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height,compact:field.type==='checkbox'}}),
        rows: { frequency:document.querySelector('[aria-label="执行频率"]')?.getBoundingClientRect().top, interval:document.querySelector('input[type="number"]')?.getBoundingClientRect().top, bot:document.querySelector('[aria-label="通知机器人"]')?.getBoundingClientRect().top, session:document.querySelector('[aria-label="通知会话"]')?.getBoundingClientRect().top },
        projectRow:[...document.querySelectorAll('.schedule-form-grid:first-of-type select')].map(field=>field.getBoundingClientRect().top), instruction:document.querySelector('textarea')?.value };
    })()` }, sessionId)
    const measured = result.result.value
    assert.equal(measured.centered,true,`${name} ${width}px: frequency tab labels are centered`)
    assert.equal(measured.overflow, false, `${width}px: no horizontal overflow`)
    if (name==='task') assert.match(measured.instruction, /CLI/)
    if (name==='list') {
      const {result: listResult}=await call('Runtime.evaluate',{returnByValue:true,expression:`(() => {
        const target=document.querySelector('.schedule-task-target'), time=document.querySelector('.schedule-list-time');
        const rect=time.getBoundingClientRect();
        return {ellipsis:getComputedStyle(target).textOverflow, clipped:target.scrollWidth>target.clientWidth,
          text:document.querySelector('.schedule-list-item').textContent, timeHeight:rect.height,
          lineHeight:parseFloat(getComputedStyle(time).lineHeight), right:rect.right};
      })()`},sessionId)
      const list=listResult.result.value
      assert.equal(list.ellipsis,'ellipsis')
      assert.ok(list.clipped,`${width}px: long task title is truncated`)
      assert.doesNotMatch(list.text,/Once at|demo-task|任务协调指令|—/)
      assert.ok(list.timeHeight<=list.lineHeight+1,`${width}px: execution time stays on one line`)
      assert.ok(list.right<=width,`${width}px: execution time fits`)
      const {result: creatorResult}=await call('Runtime.evaluate',{returnByValue:true,expression:`(() => {
        const node=document.querySelector('.schedule-list-creator'), rect=node.getBoundingClientRect();
        return {text:node.textContent,ellipsis:getComputedStyle(node).textOverflow,clipped:node.scrollWidth>node.clientWidth,right:rect.right};
      })()`},sessionId)
      const creator=creatorResult.result.value
      assert.equal(creator.ellipsis,'ellipsis')
      assert.ok(creator.clipped,`${width}px: long creator name is truncated`)
      assert.ok(creator.right<=width,`${width}px: creator fits`)
      assert.doesNotMatch(creator.text,/创建者：|未记录/)

    }
    if (name==='batchRuns') {
      const {result: linksResult}=await call('Runtime.evaluate',{returnByValue:true,expression:`[...document.querySelectorAll('.schedule-run-task-link')].map(node=>{
        const r=node.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,clientWidth:node.clientWidth,scrollWidth:node.scrollWidth};
      })`},sessionId)
      const links=linksResult.result.value
      assert.equal(links.length,5)
      for(const link of links) {
        assert.ok(link.left>=0 && link.right<=width,`${width}px: batch task link fits`)
        assert.ok(link.scrollWidth<=link.clientWidth+1,`${width}px: full long task label wraps within its button`)
      }
    }
    if (name==='entry' || name==='taskSchedules') {
      const {result: controlResult}=await call('Runtime.evaluate',{returnByValue:true,expression:`(() => {
        const node=document.querySelector('.task-schedules-trigger, .task-schedules-dialog'), rect=node.getBoundingClientRect();
        return {left:rect.left,right:rect.right,height:rect.height,text:node.textContent};
      })()`},sessionId)
      const control=controlResult.result.value
      assert.ok(control.left>=0 && control.right<=width,`${width}px: schedule control fits`)
      assert.ok(control.height>=26,`${width}px: usable schedule control`)
      assert.match(control.text,name==='entry'?/1/:/每十分钟汇报当前任务进度/)
    }
    if (width <= 1023 && ['task','project'].includes(name)) {
      if (name==='task') {
      assert.ok(Math.abs(measured.rows.frequency - measured.rows.interval) < 2, `${width}px: frequency and interval share a row`)
      assert.ok(Math.abs(measured.rows.bot - measured.rows.session) < 2, `${width}px: bot and session share a row`)
      } else {
        assert.equal(measured.projectRow.length,2)
        assert.ok(Math.abs(measured.projectRow[0]-measured.projectRow[1])<2, `${width}px: project workflow and start step share a row`)
      }
    }
    for (const field of measured.fields) {
      assert.ok(field.left >= 0 && field.right <= width, `${width}px: fields remain in viewport`)
      assert.ok(field.height >= (field.compact ? 16 : 30), `${width}px: controls remain usable`)
    }
    if (name==='batchRuns') await call('Runtime.evaluate', {
      expression:"document.querySelector('.schedule-runs').scrollIntoView({block:'start'})",
    },sessionId)
    const screenshot = await call('Page.captureScreenshot', { format: 'png' }, sessionId)
    fs.writeFileSync(path.join(dir, `${name}-${width}.png`), Buffer.from(screenshot.result.data, 'base64'))
    console.log(`${name} ${width}px: schedule fields visible, no overflow`)
  }
  }
  console.log(`Screenshots: ${dir}`)
} finally {
  clearTimeout(timeout)
  await call('Browser.close')
  browser.kill()
}
