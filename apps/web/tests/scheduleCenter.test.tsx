import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import ScheduleCenter from '../src/components/ScheduleCenter'
import { scheduleApi, workflowApi, taskApi, type Project, type ProjectSchedule } from '../src/api/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { useProjectStore } from '../src/stores/projectStore'
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'
import ResponsiveNavigation from '../src/components/ResponsiveNavigation'
import { useTaskStore } from '../src/stores/taskStore'
import { useTaskRecord } from '../src/hooks/useTaskRecord'

const projects: Project[] = ['a', 'b'].map(id => ({
  id, name: `项目${id.toUpperCase()}`, path: `/tmp/${id}`, steps: {},
  workflows: [{ id: `flow-${id}`, name: `流程${id.toUpperCase()}`, is_default: true, nodeCount: 0 }],
}))
const schedule = (id: string): ProjectSchedule => ({
  id: `schedule-${id}`, name: `任务${id}`, workflow_id: `flow-${id}`,
  task_template: { title: `定时任务${id.toUpperCase()}`, description: '说明' },
  rule: { kind: 'daily', time: '09:00', timezone: 'Asia/Shanghai' },
  summary: '每天 09:00', cron_expression: '0 9 * * *', timezone: 'Asia/Shanghai',
  execution_mode: 'workflow', overlap_policy: 'skip', status: 'active', created_at: '', updated_at: '',
})
function Route() { const location = useLocation(); return <output id="route">{location.pathname + location.search}</output> }
async function setup() {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const projectState = useProjectStore.getState(), sessionState = useGatewaySessionStore.getState()
  const original = { ...scheduleApi }, originalWorkflowGet = workflowApi.get, originalFetch = globalThis.fetch
  const reads: string[] = []
  useProjectStore.setState({ projects, activeProject: projects[0], activeWorkflowId: 'flow-a' })
  useGatewaySessionStore.setState({ session: null })
  scheduleApi.list = async id => { reads.push(id); return { schedules: [schedule(id)] } }
  scheduleApi.notificationOptions = async () => ({choices:[],default:{enabled:false}})
  scheduleApi.preview = async () => ({ cron_expression: '0 9 * * *', timezone: 'Asia/Shanghai', summary: '', next_runs: ['2026-10-15T01:00:00Z'] })
  scheduleApi.runs = async () => ({ runs: [] })
  workflowApi.get = async id => ({ id, name: id, steps: { nodes: [] } }) as any
  globalThis.fetch = async () => Response.json({ providers: [], buttons: [], assistants: [], models: [] })
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  const render = () => act(async () => root.render(<MemoryRouter initialEntries={['/tasks?project=项目A&workflow=flow-a']}><I18nProvider><ScheduleCenter /><Route /></I18nProvider></MemoryRouter>))
  const button = (name: string, scope: ParentNode = document.body) => {
    const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === name || b.getAttribute('aria-label') === name)
    assert.ok(found, `button: ${name}`); return found
  }
  const click = (name: string) => act(async () => button(name).click())
  const cleanup = async () => {
    await act(async () => root.unmount()); container.remove()
    Object.assign(scheduleApi, original); workflowApi.get = originalWorkflowGet; globalThis.fetch = originalFetch
    useProjectStore.setState(projectState); useGatewaySessionStore.setState(sessionState)
    await window.happyDOM.close()
  }
  return { window, container, reads, render, button, click, cleanup }
}

test('global schedules reuse the project editor and switch scope without changing the board or route', async () => {
  const app = await setup()
  try {
    await app.render(); await app.click('定时任务')
    assert.equal(document.querySelectorAll('.schedule-center-tabs [role="tab"]').length, 2)
    assert.ok(document.querySelector('.schedule-page'))
    assert.match(document.querySelector('.schedule-list')!.textContent!, /定时任务A/)
    await app.click('项目B')
    assert.match(document.querySelector('.schedule-list')!.textContent!, /定时任务B/)
    assert.doesNotMatch(document.querySelector('.schedule-list')!.textContent!, /定时任务A/)
    await act(async () => document.querySelector<HTMLButtonElement>('.schedule-list-item')!.click())
    assert.equal(document.querySelector<HTMLSelectElement>('.schedule-editor select')!.value, 'flow-b')
    assert.ok([...document.querySelectorAll<HTMLOptionElement>('.schedule-editor option')].some(o => o.value === 'flow-b'))
    assert.ok(![...document.querySelectorAll<HTMLOptionElement>('.schedule-editor option')].some(o => o.value === 'flow-a'))
    assert.deepEqual(app.reads, ['a', 'b'])
    assert.equal(useProjectStore.getState().activeProject?.id, 'a')
    assert.equal(useProjectStore.getState().activeWorkflowId, 'flow-a')
    assert.equal(document.querySelector('#route')?.textContent, '/tasks?project=项目A&workflow=flow-a')
    await app.click('关闭')
    assert.equal(document.querySelector('[role="dialog"]'), null)
  } finally { await app.cleanup() }
})

test('a new untouched schedule can close directly from the header', async () => {
  const app = await setup()
  try {
    await app.render(); await app.click('定时任务'); await app.click('新建定时任务')
    await app.click('关闭')
    assert.equal(document.querySelector('.confirm-dialog-panel'), null)
    assert.equal(document.querySelector('.schedule-center-dialog'), null)
  } finally { await app.cleanup() }
})

test('discard confirmation escapes the navigation container and closes the schedule editor', async () => {
  const app = await setup()
  try {
    await app.render(); await app.click('定时任务'); await app.click('新建定时任务')
    await act(async () => {
      const input = [...document.querySelectorAll<HTMLInputElement>('.schedule-editor input')].find(input => input.type === 'text')!
      Object.getOwnPropertyDescriptor(app.window.HTMLInputElement.prototype, 'value')!.set!.call(input, '新任务')
      input.dispatchEvent(new app.window.Event('input', { bubbles: true }))
    })
    await app.click('关闭')
    const backdrop = document.querySelector('.confirm-dialog-backdrop')!
    assert.equal(backdrop.parentElement, document.body, 'confirmation must not be clipped or hidden by the navigation container')
    await app.click('放弃')
    assert.equal(document.querySelector('.schedule-center-dialog'), null)
  } finally { await app.cleanup() }
})

test('unsaved changes guard project switching and close; saving writes only to the tab project', async () => {
  const app = await setup()
  const writes: { projectId: string; workflowId: string }[] = []
  scheduleApi.create = async (id, payload) => { writes.push({ projectId: id, workflowId: payload.workflow_id }); return { ...schedule(id), ...payload } }
  try {
    await app.render(); await app.click('定时任务'); await app.click('项目B'); await app.click('新建定时任务')
    await act(async () => {
      const input = [...document.querySelectorAll<HTMLInputElement>('.schedule-editor input')].find(i => i.type === 'text')!
      Object.getOwnPropertyDescriptor(app.window.HTMLInputElement.prototype, 'value')!.set!.call(input, '新任务')
      input.dispatchEvent(new app.window.Event('input', { bubbles: true }))
    })
    await app.click('项目A')
    assert.ok(document.querySelector('.confirm-dialog-panel'))
    await app.click('取消')
    assert.equal(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent, '项目B')
    await app.click('关闭')
    assert.ok(document.querySelector('.confirm-dialog-panel'))
    await app.click('取消')
    await act(async () => new Promise(resolve => setTimeout(resolve, 280)))
    await app.click('保存')
    assert.deepEqual(writes, [{ projectId: 'b', workflowId: 'flow-b' }])
    await app.click('项目A')
    assert.equal(document.querySelector('.confirm-dialog-panel'), null)
    assert.equal(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent, '项目A')
  } finally { await app.cleanup() }
})

test('late responses from a previous tab cannot replace the new project schedules', async () => {
  const app = await setup()
  let resolveA!: (result: { schedules: ProjectSchedule[] }) => void
  scheduleApi.list = id => id === 'a' ? new Promise(resolve => { resolveA = resolve }) : Promise.resolve({ schedules: [schedule(id)] })
  try {
    await app.render(); await app.click('定时任务'); await app.click('项目B')
    await act(async () => resolveA({ schedules: [schedule('a')] }))
    assert.match(document.querySelector('.schedule-list')!.textContent!, /定时任务B/)
    assert.doesNotMatch(document.querySelector('.schedule-list')!.textContent!, /定时任务A/)
  } finally { await app.cleanup() }
})

test('switching later project tabs preserves the horizontal tab scroll position', async () => {
  const app = await setup()
  try {
    useProjectStore.setState({ projects: [...projects, ...Array.from({ length: 20 }, (_, index) => ({
      ...projects[0], id: `extra-${index}`, name: `后面的项目${index}`,
    }))] })
    await app.render(); await app.click('定时任务')
    const strip = document.querySelector<HTMLElement>('.schedule-center-tabs')!
    strip.scrollLeft = 640
    strip.dispatchEvent(new app.window.Event('scroll'))
    await app.click('后面的项目18')
    assert.equal(document.querySelector<HTMLElement>('.schedule-center-tabs')!.scrollLeft, 640)
    assert.equal(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent, '后面的项目18')
    const currentStrip = document.querySelector<HTMLElement>('.schedule-center-tabs')!
    currentStrip.scrollLeft = 780
    currentStrip.dispatchEvent(new app.window.Event('scroll'))
    await app.click('后面的项目19')
    assert.equal(document.querySelector<HTMLElement>('.schedule-center-tabs')!.scrollLeft, 780)
    assert.ok(document.querySelector('.schedule-center-tabs') === strip, 'the scroll container must survive project switches')
    assert.equal(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent, '后面的项目19')
    await app.click('后面的项目18')
    assert.ok(document.querySelector('.schedule-center-tabs') === strip)
    assert.equal(strip.scrollLeft, 780)
  } finally { await app.cleanup() }
})

test('bound read-only sessions see only their permitted project and cannot create schedules', async () => {
  const app = await setup()
  try {
    app.window.happyDOM.setURL('http://d-device.localhost:8700/')
    useGatewaySessionStore.setState({ session: { host_project_id: 'b', access_level: 'read', permissions: ['schedule.read'] } as any })
    await app.render(); await app.click('定时任务')
    assert.deepEqual([...document.querySelectorAll('.schedule-center-tabs [role="tab"]')].map(t => t.textContent), ['项目B'])
    assert.deepEqual(app.reads, ['b'])
    assert.equal(document.querySelector('.schedule-new-button'), null)
  } finally { await app.cleanup() }
})

test('empty project catalogs show a useful empty state without schedule requests', async () => {
  const app = await setup()
  try {
    useProjectStore.setState({ projects: [], activeProject: null })
    await app.render(); await app.click('定时任务')
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /还没有项目/)
    assert.deepEqual(app.reads, [])
  } finally { await app.cleanup() }
})

test('loading workflow review defaults does not make an untouched schedule dirty', async () => {
  const app = await setup()
  workflowApi.get = async id => ({ id, name: id, steps: { nodes: [{ key: 'develop', title: '开发', review: { mode: 'manual' } }] } }) as any
  scheduleApi.list = async id => ({ schedules: [{ ...schedule(id), workflow_id: `other-${id}` }] })
  try {
    await app.render(); await app.click('定时任务')
    await act(async () => document.querySelector<HTMLButtonElement>('.schedule-list-item')!.click())
    await app.click('项目B')
    assert.equal(document.querySelector('.confirm-dialog-panel'), null)
    assert.equal(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent, '项目B')
  } finally { await app.cleanup() }
})

test('mobile entry dismisses the navigation drawer while keeping the schedules window open', async () => {
  const app = await setup()
  app.window.innerWidth = 390
  const oldHistory = globalThis.history
  Object.assign(globalThis, { history: app.window.history })
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><ResponsiveNavigation title="项目A" onNew={() => {}}>
      <ScheduleCenter />
    </ResponsiveNavigation></I18nProvider></MemoryRouter>))
    await act(async () => container.querySelector<HTMLButtonElement>('.mobile-header button')!.click())
    assert.ok(container.querySelector('.responsive-navigation.is-open'))
    await act(async () => container.querySelector<HTMLButtonElement>('.layout-sidebar-nav-button')!.click())
    assert.equal(container.querySelector('.responsive-navigation.is-open'), null)
    assert.ok(document.querySelector('.schedule-center-dialog'))
    await app.click('新建定时任务')
    await act(async () => {
      const input = [...document.querySelectorAll<HTMLInputElement>('.schedule-editor input')].find(input => input.type === 'text')!
      Object.getOwnPropertyDescriptor(app.window.HTMLInputElement.prototype, 'value')!.set!.call(input, '移动端任务')
      input.dispatchEvent(new app.window.Event('input', { bubbles: true }))
    })
    await act(async () => document.querySelector<HTMLButtonElement>('.schedule-close-button')!.click())
    const confirmation = document.querySelector('.confirm-dialog-panel')!
    assert.ok(confirmation)
    assert.equal(confirmation.closest('[inert], .responsive-navigation'), null)
    await app.click('放弃')
    assert.equal(document.querySelector('.schedule-center-dialog'), null)
  } finally { await act(async () => root.unmount()); container.remove(); await app.cleanup(); Object.assign(globalThis, { history: oldHistory }) }
})

test('saving blocks switching; failures retain the editor and its discard protection', async () => {
  const app = await setup()
  let rejectSave!: (error: Error) => void
  scheduleApi.update = () => new Promise((_resolve, reject) => { rejectSave = reject })
  try {
    await app.render(); await app.click('定时任务')
    await act(async () => document.querySelector<HTMLButtonElement>('.schedule-list-item')!.click())
    await app.click('按间隔')
    await act(async () => new Promise(resolve => setTimeout(resolve, 280)))
    await app.click('保存')
    assert.ok([...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].every(tab => tab.disabled))
    await act(async () => rejectSave(new Error('保存失败')))
    assert.match(document.querySelector('.schedule-page [role="alert"]')!.textContent!, /保存失败/)
    await app.click('项目B')
    assert.ok(document.querySelector('.confirm-dialog-panel'))
    await app.click('放弃')
    assert.equal(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent, '项目B')
  } finally { await app.cleanup() }
})

for (const batch of [false, true]) test(`opening a ${batch ? 'batch' : 'legacy'} run uses the tab project even when the board URL points at another project`, async () => {
  const app = await setup()
  const oldTaskState = useTaskStore.getState(), calls: string[] = []
  useTaskStore.setState({ tasks: [] })
  scheduleApi.runs = async () => ({ runs: [{ id: 'run-b', schedule_id: 'schedule-b', scheduled_for: '2026-10-14T01:00:00Z',
    status: batch ? 'failed' : 'succeeded', task_id: batch ? 'first-task' : 'run-task',
    created_tasks: batch ? [{id:'first-task',title:'第一项',workflow_id:'flow-b'}, {id:'run-task',title:'第二项',workflow_id:'flow-b'}] : undefined,
  }] })
  globalThis.fetch = async input => {
    const url = String(input); calls.push(url)
    if (/\/task\/run-task\?/.test(url)) return Response.json({ detail: 'Task not found' }, { status: 404 })
    return Response.json({ tasks: [], messages: [], artifacts: [], reviews: [], runs: [], proposals: [], supplements: [], sessions: [], providers: [], buttons: [], configured: {}, resolved: {}, available_engines: [] })
  }
  try {
    await app.render(); await app.click('定时任务'); await app.click('项目B')
    await act(async () => document.querySelector<HTMLButtonElement>('.schedule-list-item')!.click())
    await app.click(batch ? '第二项' : '查看任务')
    assert.ok(calls.includes('/api/task/run-task?project_id=b'))
    assert.ok(!calls.includes('/api/task/run-task?project_id=a'))
    assert.ok(!calls.some(url => url.includes('/task/list')), 'opening a run must not replace the board list')
    assert.equal(useTaskStore.getState().tasks.length, 0, 'a task from another project must not enter the board list')
    assert.equal(useProjectStore.getState().activeProject?.id, 'a')
  } finally { await app.cleanup(); useTaskStore.setState(oldTaskState) }
})

test('isolated task records load successfully without adding another project to the board', async () => {
  const app = await setup(), previousTasks = useTaskStore.getState()
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  function Record() {
    const { task } = useTaskRecord('run-task', 'b', undefined, true)
    return <output>{task?.title}</output>
  }
  globalThis.fetch = async () => Response.json({ id: 'run-task', title: 'B 的执行任务', status: 'done', steps: [] })
  useTaskStore.setState({ tasks: [] })
  try {
    await act(async () => root.render(<Record />))
    assert.equal(container.textContent, 'B 的执行任务')
    assert.equal(useTaskStore.getState().tasks.length, 0)
  } finally {
    await act(async () => root.unmount()); container.remove(); useTaskStore.setState(previousTasks); await app.cleanup()
  }
})


test('schedule type tabs separate once from every recurring rule without reloading or losing edits', async () => {
  const app = await setup()
  const kinds = ['once', 'daily', 'weekly', 'monthly', 'interval', 'cron'] as const
  scheduleApi.list = async id => {
    app.reads.push(id)
    return { schedules: kinds.map(kind => ({ ...schedule(id), id: kind,
      task_template: { title: `分类-${kind}` },
      rule: { ...schedule(id).rule, kind, run_at: '2026-12-01T09:00:00' } as ProjectSchedule['rule'],
    })) }
  }
  const titles = () => [...document.querySelectorAll('.schedule-list-item')].map(item => item.textContent!)
  try {
    await app.render(); await app.click('定时任务')
    assert.equal(document.querySelector('.schedule-list [role="tab"][aria-selected="true"]')?.textContent, '周期性')
    assert.deepEqual([...document.querySelectorAll('.schedule-list [role="tab"]')].map(tab => tab.textContent), ['周期性', '一次性'])
    assert.equal(titles().length, 5)
    assert.ok(titles().every(title => !title.includes('分类-once')))
    await app.click('一次性')
    assert.equal(titles().length, 1)
    assert.match(titles()[0], /分类-once/)
    await act(async () => document.querySelector<HTMLButtonElement>('.schedule-list-item')!.click())
    const input = [...document.querySelectorAll<HTMLInputElement>('.schedule-editor input')].find(input => input.type === 'text')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(app.window.HTMLInputElement.prototype, 'value')!.set!.call(input, '未保存修改')
      input.dispatchEvent(new app.window.Event('input', { bubbles: true }))
    })
    await app.click('周期性')
    assert.equal(titles().length, 5)
    assert.equal(input.value, '未保存修改')
    await app.click('一次性')
    assert.equal(input.value, '未保存修改')
    assert.deepEqual(app.reads, ['a'])
  } finally { await app.cleanup() }
})

test('an empty schedule category shows an empty state even when the other category has items', async () => {
  const app = await setup()
  try {
    await app.render(); await app.click('定时任务'); await app.click('一次性')
    assert.equal(document.querySelectorAll('.schedule-list-item').length, 0)
    assert.match(document.querySelector('.schedule-list')!.textContent!, /暂无此类型的定时任务/)
    const tab = app.button('一次性')
    await act(async () => tab.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    assert.equal(document.querySelector('.schedule-list [aria-selected="true"]')?.textContent, '周期性')
    assert.equal(document.activeElement, app.button('周期性'))
  } finally { await app.cleanup() }
})


test('task-target schedules show the rule name and task without changing project selection', async () => {
  const app = await setup()
  const originalList = taskApi.list
  taskApi.list = async () => ({ tasks: [{ id:'existing-task', title:'已有任务' }] }) as any
  scheduleApi.list = async id => ({ schedules: [{ ...schedule(id), target_type:'task', target_task_id:'existing-task', target_task_title:'已有任务', name:'每十分钟汇报', instruction:'检查任务', task_template:{}, rule:{kind:'minutes',every:10,timezone:'UTC'} }] })
  try {
    await app.render(); await app.click('定时任务')
    assert.match(document.querySelector('.schedule-list')!.textContent!, /每十分钟汇报/)
    assert.equal(document.querySelector('.schedule-task-target')!.textContent, '已有任务')
    assert.doesNotMatch(document.querySelector('.schedule-list-item')!.textContent!, /existing-task|任务协调指令|检查任务/)
    await act(async () => document.querySelector<HTMLButtonElement>('.schedule-list-item')!.click())
    assert.ok(document.querySelector('.task-schedule-editor'))
    assert.equal(document.querySelector<HTMLSelectElement>('[aria-label="关联任务"]')!.disabled, true)
    assert.equal(useProjectStore.getState().activeProject?.id, 'a')
  } finally { taskApi.list = originalList; await app.cleanup() }
})

test('once schedules show a single compact local execution time even after completion', async () => {
  const app = await setup()
  scheduleApi.list = async id => ({ schedules: [{ ...schedule(id), status:'completed', next_run_at:null,
    rule:{kind:'once',run_at:'2026-10-16T23:00:00+08:00',timezone:'Asia/Shanghai'},
    summary:'Once at 2026-10-16T23:00:00+08:00',
  }] })
  try {
    await app.render(); await app.click('定时任务'); await app.click('一次性')
    const meta = document.querySelector('.schedule-list-meta')!
    const date = new Date('2026-10-16T23:00:00+08:00')
    const pad = (value: number) => String(value).padStart(2, '0')
    assert.equal(meta.textContent, `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`)
    assert.equal(meta.querySelectorAll('time').length, 1)
    assert.equal(meta.querySelector('time')?.dateTime, '2026-10-16T23:00:00+08:00')
    assert.doesNotMatch(meta.textContent!, /Once|T23|08:00|—/)
  } finally { await app.cleanup() }
})


test('schedule list shows creator names, falls back to usernames and hides missing creators', async () => {
  const app = await setup()
  try {
    scheduleApi.list = async () => ({ schedules: [
      { ...schedule('named'), creator_name: '张三', creator_username: 'zhangsan' },
      { ...schedule('account'), creator_name: '  ', creator_username: 'lisi' },
      schedule('legacy'),
      { ...schedule('once'), creator_name: '王五', rule: { kind: 'once', run_at: '2099-01-01T00:00:00Z', timezone: 'UTC' } },
      { ...schedule('task'), target_type: 'task', creator_name: '赵六' },
    ] })
    await app.render(); await app.click('定时任务')
    const creators = () => [...document.querySelectorAll('.schedule-list-creator')].map(node => node.textContent)
    assert.deepEqual(creators(), ['张三', 'lisi', '赵六'])
    await app.click('一次性')
    assert.deepEqual(creators(), ['王五'])
  } finally { await app.cleanup() }
})


test('batch run history lists every created task including partial failures', async () => {
  const app = await setup()
  try {
    scheduleApi.runs = async () => ({ runs: [{ id: 'batch-run', schedule_id: 'schedule-a', scheduled_for: '', status: 'failed', reason: 'disk full',
      task_id: 'first', created_tasks: [{ id: 'first', title: '批量任务一' }, { id: 'second', title: '批量任务二' }] }] })
    await app.render(); await app.click('定时任务')
    await act(async () => document.querySelector<HTMLButtonElement>('.schedule-list-item')!.click())
    assert.deepEqual([...document.querySelectorAll('.schedule-run-task-link')].map(node => node.textContent), ['批量任务一', '批量任务二'])
    assert.match(document.querySelector('.schedule-page')!.textContent!, /disk full/)
  } finally { await app.cleanup() }
})
