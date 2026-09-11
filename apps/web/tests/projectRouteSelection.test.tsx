import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { workflowApi, type Project } from '../src/api/client.ts'
import { useProjectRouteSelection } from '../src/hooks/useProjectRouteSelection.ts'
import { useProjectStore } from '../src/stores/projectStore.ts'
import { projectSelectionPath } from '../src/utils/projectSelectionPath.ts'

test('switching projects from chat carries the clicked project into the task URL', () => {
  assert.equal(
    projectSelectionPath('/chat', '测试项目'),
    '/tasks?project=%E6%B5%8B%E8%AF%95%E9%A1%B9%E7%9B%AE',
  )
})

test('task detail deep link restores its project and non-default workflow', async () => {
  const window = new Window()
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const original = workflowApi.get
  const project = {
    id: 'project', name: '项目', path: '/tmp/project', steps: { marker: 'default' },
    workflows: [
      { id: 'default', name: '默认流程', is_default: true },
      { id: 'simple', name: '简单流程', is_default: false },
    ],
  } as Project
  workflowApi.get = async () => ({ id: 'simple', steps: { marker: 'simple' } }) as any
  useProjectStore.setState({ projects: [project], activeProject: null, activeWorkflowId: null })
  function Surface() {
    useProjectRouteSelection()
    return null
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/tasks?project=%E9%A1%B9%E7%9B%AE&workflow=simple&task=task']}>
          <Surface />
        </MemoryRouter>,
      )
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.equal(useProjectStore.getState().activeProject?.id, 'project')
    assert.equal(useProjectStore.getState().activeWorkflowId, 'simple')
    assert.deepEqual(useProjectStore.getState().activeProject?.steps, { marker: 'simple' })
  } finally {
    workflowApi.get = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('an active non-default workflow canonicalizes a bare task-list URL', async () => {
  const window = new Window()
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const project = {
    id: 'project', name: '项目', path: '/tmp/project', steps: { marker: 'simple' },
    workflows: [
      { id: 'default', name: '默认流程', is_default: true },
      { id: 'simple', name: '简单流程', is_default: false },
    ],
  } as Project
  useProjectStore.setState({ projects: [project], activeProject: project, activeWorkflowId: 'simple' })
  function Surface() {
    useProjectRouteSelection()
    const location = useLocation()
    return <output>{location.search}</output>
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => {
      root.render(<MemoryRouter initialEntries={['/tasks']}><Surface /></MemoryRouter>)
    })
    assert.equal(document.querySelector('output')?.textContent, '?project=%E9%A1%B9%E7%9B%AE&workflow=simple')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('chat deep link restores its project before the chat page mounts', async () => {
  const window = new Window()
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const project = {
    id: 'project', name: '项目', path: '/tmp/project', steps: {}, workflows: [],
  } as unknown as Project
  useProjectStore.setState({ projects: [project], activeProject: null, activeWorkflowId: null })
  function Surface() {
    useProjectRouteSelection()
    return null
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/chat?project=%E9%A1%B9%E7%9B%AE&session=session-1']}>
          <Surface />
        </MemoryRouter>,
      )
    })
    assert.equal(useProjectStore.getState().activeProject?.id, 'project')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
