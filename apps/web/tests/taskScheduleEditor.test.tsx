import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import TaskScheduleEditor from '../src/components/TaskScheduleEditor'
import ScheduledMessageStatus from '../src/components/ScheduledMessageStatus'
import { scheduleApi, taskApi, type ProjectSchedule } from '../src/api/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'

async function setup() {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const originalSchedule = { ...scheduleApi }, originalTask = { ...taskApi }
  taskApi.list = async () => ({ tasks: [{ id:'task', title:'演示任务' }] }) as any
  scheduleApi.notificationOptions = async () => ({choices:[],default:{enabled:false}})
  scheduleApi.preview = async () => ({ next_runs:['2026-10-20T00:10:00Z'], summary:'', timezone:'UTC', cron_expression:null })
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  const render = async (element: React.ReactNode) => act(async () => root.render(<I18nProvider>{element}</I18nProvider>))
  const set = async (selector: string, value: string) => act(async () => {
    const input = document.querySelector(selector) as HTMLInputElement
    assert.ok(input, selector)
    const prototype = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : input.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new window.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles:true }))
  })
  const cleanup = async () => { await act(async () => root.unmount()); container.remove(); Object.assign(scheduleApi, originalSchedule); Object.assign(taskApi,originalTask); await window.happyDOM.close() }
  const openTasks = () => act(async () => {
    const input = document.querySelector<HTMLInputElement>('[aria-label="关联任务"]')!
    input.focus(); input.click()
  })
  const chooseTask = async (title: string) => {
    await openTasks()
    await act(async () => {
      const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(item => item.textContent?.includes(title))
      assert.ok(option, title); option.click()
    })
  }
  const key = (key: string) => act(async () => document.querySelector<HTMLInputElement>('[aria-label="关联任务"]')!.dispatchEvent(new window.KeyboardEvent('keydown', {key,bubbles:true})))
  return { render, set, cleanup, openTasks, chooseTask, key }
}

test('task form validates and saves a minute instruction without a creation template', async () => {
  const app = await setup()
  let payload: any, saved: ProjectSchedule | undefined, dirty = false
  scheduleApi.create = async (_id, body) => { payload = body; return { ...body, id:'rule' } as any }
  try {
    await app.render(<TaskScheduleEditor projectId="project" schedule={null} onSaved={value => { saved=value }} onEditorStateChange={state => { dirty=state.dirty }} />)
    assert.equal(document.querySelector<HTMLButtonElement>('.task-schedule-editor > button')!.disabled,true)
    await app.set('[aria-label="标题"]','进度汇报')
    await app.chooseTask('演示任务')
    await app.set('textarea','汇报进度并使用 CLI 发到绑定群')
    await act(async () => new Promise(resolve => setTimeout(resolve,280)))
    assert.equal(dirty,true)
    await act(async () => document.querySelector<HTMLButtonElement>('.task-schedule-editor > button')!.click())
    assert.equal(saved?.id,'rule')
    assert.equal(payload.target_type,'task')
    assert.equal(payload.target_task_id,'task')
    assert.equal(payload.rule.kind,'minutes')
    assert.equal(payload.rule.every,10)
    assert.equal(payload.overlap_policy,'skip')
    assert.deepEqual(payload.task_template,{})
  } finally { await app.cleanup() }
})

test('scheduled message stop is message-scoped and readonly history exposes no stop', async () => {
  const app = await setup()
  const calls: unknown[][] = []
  taskApi.stopCoordinator = async (...args) => { calls.push(args); return { stopped:true } }
  const message = { id:'reply', role:'assistant', run_status:'running', schedule_run_id:'run' }
  try {
    await app.render(<ScheduledMessageStatus projectId="p" taskId="t" message={message} canStop />)
    await act(async () => document.querySelector<HTMLButtonElement>('.chat-message-action')!.click())
    assert.deepEqual(calls,[['t','p','reply']])
    await app.render(<ScheduledMessageStatus projectId="p" taskId="t" message={message} canStop={false} />)
    assert.equal(document.querySelector('.chat-message-action'),null)
    assert.match(document.body.textContent!, /定时执行/)
  } finally { await app.cleanup() }
})


test('workflow selection filters tasks locally and clears an incompatible selected task', async () => {
  const app = await setup()
  let reads = 0
  taskApi.list = async () => { reads++; return { tasks:[
    { id:'a-task', title:'流程 A 的任务', workflow_id:'a' },
    { id:'b-task', title:'流程 B 的任务', workflow_id:'b' },
  ] } as any }
  try {
    await app.render(<TaskScheduleEditor projectId="p" schedule={null} workflows={[{id:'a',name:'流程 A'},{id:'b',name:'流程 B'}]} onSaved={() => {}} />)
    const options = async () => { await app.openTasks(); return [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(option => option.dataset.value) }
    assert.deepEqual(await options(),['a-task','b-task'])
    await app.set('[aria-label="关联流程"]','a')
    assert.deepEqual(await options(),['a-task'])
    await app.chooseTask('流程 A 的任务')
    await app.set('[aria-label="关联流程"]','b')
    assert.deepEqual(await options(),['b-task'])
    assert.equal(document.querySelector<HTMLSelectElement>('[aria-label="关联任务"]')!.value,'')
    await app.set('[aria-label="关联流程"]','')
    assert.deepEqual(await options(),['a-task','b-task'])
    assert.equal(reads,1)
  } finally { await app.cleanup() }
})

test('editing shows the bound task workflow without changing the immutable target', async () => {
  const app = await setup()
  taskApi.list = async () => ({tasks:[{id:'task', title:'已有任务', workflow_id:'b'}]}) as any
  try {
    await app.render(<TaskScheduleEditor projectId="p" schedule={{id:'rule', target_task_id:'task', instruction:'汇报', name:'规则'} as ProjectSchedule} workflows={[{id:'b',name:'流程 B'}]} onSaved={() => {}} />)
    const workflow = document.querySelector<HTMLSelectElement>('[aria-label="关联流程"]')!
    assert.equal(workflow.value,'b')
    assert.equal(workflow.disabled,true)
    assert.equal(document.querySelector<HTMLSelectElement>('[aria-label="关联任务"]')!.value,'已有任务')
  } finally { await app.cleanup() }
})


test('task search and dropdown are one control showing name, creator and time without IDs', async () => {
  const app = await setup()
  taskApi.list = async () => ({ tasks:[
    { id:'long-private-task-id', title:'交付检查', creator_name:'小林', created_at:'2026-10-16T08:30:00+08:00' },
    { id:'another-private-id', title:'需求梳理', creator_name:'小张', created_at:'2026-10-15T10:00:00+08:00' },
  ] }) as any
  try {
    await app.render(<TaskScheduleEditor projectId="p" schedule={null} onSaved={() => {}} />)
    assert.equal(document.querySelector('[aria-label="搜索任务名或创建者"]'),null)
    assert.equal(document.querySelector('[aria-label="关联任务"]')?.getAttribute('role'),'combobox')
    await app.openTasks()
    const list = document.querySelector('[role="listbox"]')!
    assert.match(list.textContent!,/交付检查/)
    assert.match(list.textContent!,/小林/)
    assert.match(list.textContent!,/2026/)
    assert.doesNotMatch(list.textContent!,/long-private-task-id|another-private-id/)
    await app.set('[aria-label="关联任务"]','小张')
    assert.equal(document.querySelectorAll('[role="option"]').length,1)
    await app.chooseTask('需求梳理')
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="关联任务"]')!.value,'需求梳理')
    assert.equal(document.querySelector('[role="listbox"]'),null)
  } finally { await app.cleanup() }
})


test('task dropdown supports keyboard selection and refuses arbitrary search text', async () => {
  const app = await setup()
  taskApi.list = async () => ({ tasks:[{id:'a',title:'任务 A'},{id:'b',title:'任务 B'}] }) as any
  try {
    await app.render(<TaskScheduleEditor projectId="p" schedule={null} onSaved={() => {}} />)
    await app.openTasks(); await app.key('ArrowDown'); await app.key('Enter')
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="关联任务"]')!.value,'任务 B')
    await app.openTasks()
    await app.set('[aria-label="关联任务"]','不存在的任务')
    assert.equal(document.querySelectorAll('[role="option"]').length,0)
    await app.key('Enter')
    assert.ok(document.querySelector('[role="listbox"]'))
    await app.key('Escape')
    assert.equal(document.querySelector('[role="listbox"]'),null)
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="关联任务"]')!.value,'')
  } finally { await app.cleanup() }
})
