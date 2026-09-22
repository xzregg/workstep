import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { taskListPath, useTaskRoute } from '../src/hooks/useTaskRoute'

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
  assert.equal(document.querySelector('output')!.textContent, '/tasks?project=demo&workflow=flow')
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
