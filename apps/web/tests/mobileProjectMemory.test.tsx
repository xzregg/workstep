import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { fsApi, scheduleApi, type Project } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import TaskList from '../src/pages/TaskList'
import { useProjectStore } from '../src/stores/projectStore'
import { useTaskStore } from '../src/stores/taskStore'
import { useManagedModeStore } from '../src/stores/managedModeStore'

test('mobile actions open project memory and dismiss the menu', async () => {
  const { window } = installDomEnvironment()
  Object.assign(globalThis, { history: window.history })
  window.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as any
  const projectState = useProjectStore.getState()
  const taskState = useTaskStore.getState()
  const managedState = useManagedModeStore.getState()
  const originalRead = fsApi.readMemory
  const originalList = scheduleApi.list
  const reads: string[] = []
  fsApi.readMemory = async (id) => { reads.push(id); return { path: '.workstep/MEMORY.md', content: 'Demo memory' } }
  scheduleApi.list = async () => ({ schedules: [] })
  useProjectStore.setState({ activeProject: { id: 'demo', name: 'Demo', path: '/demo', workflows: [] } as unknown as Project, activeWorkflowId: null })
  useTaskStore.setState({ tasks: [], loading: false, fetchTasks: async () => {} })
  useManagedModeStore.setState({ load: async () => {} })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><TaskList /></I18nProvider></MemoryRouter>))
    await act(async () => container.querySelector<HTMLButtonElement>('.mobile-session-kebab')!.click())
    const entry = [...document.querySelectorAll<HTMLButtonElement>('.mobile-task-menu button')]
      .find(button => /^(记忆|Memory)$/.test(button.textContent?.trim() || ''))
    assert.ok(entry, 'mobile menu must offer project memory')
    await act(async () => entry.click())
    assert.equal(document.querySelector('.mobile-task-menu'), null)
    assert.ok(document.querySelector('.project-memory-panel'))
    assert.deepEqual(reads, ['demo'])
    assert.match(document.body.textContent || '', /Demo memory/)
  } finally {
    await act(async () => root.unmount())
    useProjectStore.setState(projectState, true)
    useTaskStore.setState(taskState, true)
    useManagedModeStore.setState(managedState, true)
    fsApi.readMemory = originalRead
    scheduleApi.list = originalList
    container.remove()
    await window.happyDOM.close()
  }
})
