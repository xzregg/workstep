import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { taskListPath, useTaskRoute } from '../src/hooks/useTaskRoute'
import TaskDetailHeader from '../src/components/TaskDetailHeader'
import { I18nProvider } from '../src/i18n'

test('task list route identifies its project and workflow', () => {
  assert.equal(taskListPath('项目 A', 'simple'), '/tasks?project=%E9%A1%B9%E7%9B%AE+A&workflow=simple')
})

test('task deep link closes to its project list; opening a task preserves project and workflow', async () => {
  const window = new Window()
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
  function Surface() {
    const { taskId, openTask, closeTask } = useTaskRoute()
    const location = useLocation()
    return <><output>{location.pathname}{location.search}</output><p>{taskId}</p><button onClick={closeTask}>返回</button><button onClick={() => openTask('two', '项目')}>打开</button></>
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  await act(async () => root.render(<MemoryRouter initialEntries={['/tasks?project=demo&workflow=flow&task=one']}><Surface /></MemoryRouter>))
  assert.equal(document.querySelector('p')!.textContent, 'one')
  await act(async () => document.querySelector('button')!.click())
  assert.equal(document.querySelector('output')!.textContent, '/tasks?project=demo&workflow=flow')
  await act(async () => document.querySelectorAll('button')[1].click())
  assert.equal(document.querySelector('p')!.textContent, 'two')
  assert.match(document.querySelector('output')!.textContent!, /workflow=flow/)
  await act(async () => document.querySelector('button')!.click())
  assert.equal(document.querySelector('output')!.textContent, '/tasks?project=%E9%A1%B9%E7%9B%AE&workflow=flow')
  await act(async () => root.unmount())
  await window.happyDOM.close()
})

test('opening task detail records the selected workflow when the board URL lacks it', async () => {
  const window = new Window()
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
  function Surface() {
    const { openTask } = useTaskRoute()
    const location = useLocation()
    return <><output>{location.search}</output><button onClick={() => openTask('task', '项目', 'simple')}>打开</button></>
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  await act(async () => root.render(<MemoryRouter initialEntries={['/tasks']}><Surface /></MemoryRouter>))
  await act(async () => document.querySelector('button')!.click())
  assert.match(document.querySelector('output')!.textContent!, /workflow=simple/)
  await act(async () => root.unmount())
  await window.happyDOM.close()
})

test('the close button exits detail after opening another task and receiving updates', async () => {
  const window = new Window({ width: 390 })
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
  function Surface({ revision }: { revision: number }) {
    const { taskId, openTask, closeTask } = useTaskRoute()
    const location = useLocation()
    return <>
      <output>{location.pathname}{location.search}</output>
      <button onClick={() => openTask('one', 'demo', 'flow')}>打开任务</button>
      <button onClick={() => openTask('two', 'demo', 'flow')}>打开另一任务</button>
      {taskId && <TaskDetailHeader
        task={{ id: taskId, title: `Task ${revision}`, status: 'running', steps: [], created_at: '2026-01-01T00:00:00Z' }}
        locale="zh-CN" activeStep={{ key: 'do', label: '执行', color: 'blue', prompt: '', inputs: [], outputs: [] }}
        activeStepColor="blue" taskCompleted={false} onClose={closeTask} />}
    </>
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const render = (revision: number) => root.render(<MemoryRouter initialEntries={['/tasks?project=demo&workflow=flow']}>
    <I18nProvider><Surface revision={revision} /></I18nProvider>
  </MemoryRouter>)
  try {
    await act(async () => render(0))
    await act(async () => container.querySelectorAll('button')[0].click())
    await act(async () => container.querySelectorAll('button')[1].click())
    assert.match(container.querySelector('output')!.textContent!, /task=two/)
    const close = container.querySelector<HTMLButtonElement>('.task-detail-header-close')!
    await act(async () => close.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })))
    for (let revision = 1; revision <= 10; revision++) await act(async () => render(revision))
    assert.equal(container.querySelector('.task-detail-header-close'), close, 'updates preserve the tapped button')
    await act(async () => {
      close.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }))
      close.click()
    })
    assert.equal(container.querySelector('output')!.textContent, '/tasks?project=demo&workflow=flow')
    assert.equal(container.querySelector('.task-detail-header-close'), null)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('close exits detail even when the previous history entry has the same task', async () => {
  const window = new Window()
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
  function Surface() {
    const { taskId, closeTask } = useTaskRoute()
    return <><output>{taskId}</output><button onClick={closeTask}>关闭</button></>
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const detailEntry = { pathname: '/tasks', search: '?project=demo&workflow=flow&task=one', state: { taskListEntry: true } }
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={[detailEntry, detailEntry]} initialIndex={1}><Surface /></MemoryRouter>))
    await act(async () => container.querySelector('button')!.click())
    assert.equal(container.querySelector('output')!.textContent, '')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('browser Back still returns from a task to the list that opened it', async () => {
  const window = new Window()
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
  function Surface() {
    const { taskId, openTask } = useTaskRoute()
    const navigate = useNavigate()
    return <><output>{taskId}</output><button onClick={() => openTask('one')}>打开</button><button onClick={() => navigate(-1)}>后退</button></>
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={['/tasks?project=demo&workflow=flow']}><Surface /></MemoryRouter>))
    await act(async () => container.querySelectorAll('button')[0].click())
    assert.equal(container.querySelector('output')!.textContent, 'one')
    await act(async () => container.querySelectorAll('button')[1].click())
    assert.equal(container.querySelector('output')!.textContent, '')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
