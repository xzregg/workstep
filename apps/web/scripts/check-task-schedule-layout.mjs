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
const css = ['index.css', 'mobile.css', 'pages/SchedulePage.css', 'components/TaskScheduleEditor.css', 'components/ScheduleRuleEditor.css', 'components/TaskPicker.css', 'components/ScheduleNotificationEditor.css'].map(file => fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')).join('\n')
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
await act(async()=>root.unmount())
await window.happyDOM.close()
const files = new Map()
for (const [name,content] of [['task',markup],['project',projectMarkup]]) {
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
    if (width <= 1023) {
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
