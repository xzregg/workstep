import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import TaskSchedules from '../src/components/TaskSchedules'
import { MemoryRouter } from 'react-router-dom'
import { scheduleApi, workflowApi, taskApi, type ProjectSchedule, type Project } from '../src/api/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import type { TaskScheduleSummary } from '../src/api/schedule'

const item = (id: string, kind = 'minutes', status = 'active'): TaskScheduleSummary => ({
  id, name: `规则-${id}`, status, instruction:'检查最新进度', summary:'每 10 分钟',
  rule: kind === 'once' ? {kind:'once',run_at:'2026-10-16T23:00:00+08:00',timezone:'Asia/Shanghai'}
    : {kind:'minutes',every:10,timezone:'UTC'}, next_run_at:null,
}) as TaskScheduleSummary

test('task window reuses schedule management to create, edit and delete only bound rules', async () => {
  const {window}=installDomEnvironment()
  useLocaleStore.setState({locale:'zh-CN'})
  const container=document.body.appendChild(document.createElement('div')),root=createRoot(container)
  const originals={...scheduleApi}, originalWorkflow=workflowApi.get, originalTasks=taskApi.list
  const project={id:'project',name:'项目',workflows:[],path:'/tmp/demo',steps:{}} as Project
  const boundTask={id:'bound',title:'当前任务',workflow_id:null}
  let records:ProjectSchedule[]=[], listReads=0
  const make=(payload:any)=>({...payload,id:'rule',summary:'每10分钟',status:'active',created_at:'',updated_at:'',timezone:'UTC',cron_expression:null}) as ProjectSchedule
  const load=async()=>({schedules:records})
  scheduleApi.list=async(pid,tid)=>{assert.equal(pid,'project');assert.equal(tid,'bound');listReads++;return {schedules:records}}
  scheduleApi.preview=async()=>({next_runs:['2099-01-01T00:00:00Z'],summary:'',timezone:'UTC',cron_expression:null})
  scheduleApi.notificationOptions=async()=>({choices:[],default:{enabled:false}})
  scheduleApi.runs=async()=>({runs:[]})
  scheduleApi.create=async(pid,payload)=>{assert.equal(pid,'project');assert.equal(payload.target_task_id,'bound');records=[make(payload)];return records[0]}
  scheduleApi.update=async(_pid,_id,payload)=>{records=[{...records[0],...payload}];return records[0]}
  scheduleApi.delete=async()=>{records=[];return {ok:true}}
  taskApi.list=async()=>{throw new Error('bound task editor must not load the project task list')}
  const click=async(label:string)=>act(async()=>{
    const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent?.trim()===label||button.getAttribute('aria-label')===label)
    assert.ok(button,label);button.click()
  })
  const set=async(selector:string,value:string)=>act(async()=>{
    const input=document.querySelector<HTMLInputElement>(selector)!
    Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype,'value')!.set!.call(input,value)
    input.dispatchEvent(new window.Event('input',{bubbles:true}))
  })
  try {
    await act(async()=>root.render(<MemoryRouter><I18nProvider><TaskSchedules taskId="bound" task={boundTask} project={project} load={load}/></I18nProvider></MemoryRouter>))
    await act(async()=>container.querySelector<HTMLButtonElement>('button')!.click())
    assert.ok(document.querySelector('.schedule-page'))
    await click('新建定时任务')
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="关联任务"]')?.value,'当前任务')
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="关联任务"]')?.disabled,true)
    await set('[aria-label="标题"]','新规则');await set('textarea','汇报当前进度')
    await click('关闭')
    assert.ok(document.querySelector('.confirm-dialog-panel'))
    await click('取消')
    assert.ok(document.querySelector('.task-schedule-editor'))
    await act(async()=>new Promise(resolve=>setTimeout(resolve,280)))
    await click('保存')
    assert.equal(records.length,1)
    assert.equal(container.querySelector('.task-schedules-count')?.textContent,'1')
    await set('[aria-label="标题"]','修改规则')
    await act(async()=>new Promise(resolve=>setTimeout(resolve,280)))
    await click('保存')
    assert.equal(records[0].name,'修改规则')
    await click('删除')
    const confirm=document.querySelector('.confirm-dialog-panel')!
    await act(async()=>[...confirm.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='删除')!.click())
    assert.equal(records.length,0)
    assert.equal(container.querySelector('.task-schedules-count'),null)
    assert.equal(listReads,4,'one initial list and one per mutation')
  } finally {await act(async()=>root.unmount());container.remove();Object.assign(scheduleApi,originals);workflowApi.get=originalWorkflow;taskApi.list=originalTasks;await window.happyDOM.close()}
})

test('task schedule entry counts bound schedules, hides completed once rules and opens a read-only list', async () => {
  const {window} = installDomEnvironment()
  useLocaleStore.setState({locale:'zh-CN'})
  const container=document.body.appendChild(document.createElement('div')), root=createRoot(container)
  let reads=0
  const load=async()=> { reads++; return {schedules:[item('periodic'),item('paused','minutes','paused'),item('done','once','completed'),item('future','once')]} }
  try {
    await act(async()=>root.render(<I18nProvider><TaskSchedules taskId="task-a" load={load}/></I18nProvider>))
    const trigger=container.querySelector<HTMLButtonElement>('.task-schedules-trigger')!
    assert.equal(trigger.querySelector('.task-schedules-count')?.textContent,'3')
    await act(async()=>trigger.click())
    const dialog=document.querySelector('[role="dialog"]')!
    assert.ok(dialog)
    assert.match(dialog.textContent!,/规则-periodic|规则-paused|规则-future/)
    assert.doesNotMatch(dialog.textContent!,/规则-done|Once at|T23:00/)
    assert.equal(dialog.querySelector('input,textarea'),null)
    assert.equal(reads,2,'opening refreshes the bound list')
    await act(async()=>[...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.getAttribute('aria-label')==='关闭')!.click())
    assert.equal(document.querySelector('[role="dialog"]'),null)
  } finally {await act(async()=>root.unmount());container.remove();await window.happyDOM.close()}
})

test('zero schedules keep the entry available without a badge and loading errors can retry', async () => {
  const {window}=installDomEnvironment()
  const container=document.body.appendChild(document.createElement('div')),root=createRoot(container)
  let fail=true
  const load=async()=>{if(fail) throw new Error('读取失败');return {schedules:[]}}
  try {
    await act(async()=>root.render(<I18nProvider><TaskSchedules taskId="task-a" load={load}/></I18nProvider>))
    assert.equal(container.querySelector('.task-schedules-count'),null)
    fail=false
    await act(async()=>container.querySelector<HTMLButtonElement>('button')!.click())
    assert.match(document.querySelector('[role="dialog"]')!.textContent!,/暂无/)
    assert.equal(document.querySelector('[role="alert"]'),null)
  } finally {await act(async()=>root.unmount());container.remove();await window.happyDOM.close()}
})

test('late responses do not replace another task schedule count', async () => {
  const {window}=installDomEnvironment()
  const container=document.body.appendChild(document.createElement('div')),root=createRoot(container)
  let resolve!: (result:{schedules:TaskScheduleSummary[]})=>void
  const first=()=>new Promise<{schedules:TaskScheduleSummary[]}>(done=>{resolve=done})
  const second=async()=>({schedules:[item('second')]})
  try {
    await act(async()=>root.render(<I18nProvider><TaskSchedules taskId="first" load={first}/></I18nProvider>))
    await act(async()=>root.render(<I18nProvider><TaskSchedules taskId="second" load={second}/></I18nProvider>))
    await act(async()=>resolve({schedules:[item('old'),item('older')]}))
    assert.equal(container.querySelector('.task-schedules-count')?.textContent,'1')
  } finally {await act(async()=>root.unmount());container.remove();await window.happyDOM.close()}
})
