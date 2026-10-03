import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { chatSessionApi, type Project } from '../src/api/client'
import { useSidebarSessionActions } from '../src/hooks/useSidebarSessionActions'
import { I18nProvider } from '../src/i18n'
import { useChatListStore } from '../src/stores/chatSessionStore'
import { useProjectStore } from '../src/stores/projectStore'
import { installDomEnvironment } from './helpers/domEnv'

test('deleting a sidebar conversation only selects a remaining conversation of the same type', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalRemove = chatSessionApi.remove
  const originalProjects = useProjectStore.getState()
  const originalList = useChatListStore.getState()
  const project: Project = { id: 'project-types', name: 'Types', path: '/tmp/types', steps: {}, workflows: [] }
  let controls!: ReturnType<typeof useSidebarSessionActions>
  let route = ''
  function Harness() {
    controls = useSidebarSessionActions()
    const location = useLocation()
    route = location.pathname + location.search
    return null
  }
  chatSessionApi.remove = async () => ({ success: true }) as never
  useProjectStore.setState({ projects: [project], activeProject: project })
  try {
    for (const scenario of [
      { source: undefined, remaining: true, expected: 'same-type' },
      { source: undefined, remaining: false, expected: null },
      { source: 'channel', remaining: true, expected: 'same-type' },
      { source: 'channel', remaining: false, expected: null },
    ]) {
      useChatListStore.setState({ sessionsByProject: { [project.id]: [
        { id: 'other-type', project_id: project.id, title: 'Other', source: scenario.source === 'channel' ? undefined : 'channel' },
        { id: 'deleted', project_id: project.id, title: 'Deleted', source: scenario.source },
        ...(scenario.remaining ? [{ id: 'same-type', project_id: project.id, title: 'Same', source: scenario.source }] : []),
      ] as never } })
      await act(async () => root.render(
        <MemoryRouter key={`${scenario.source}-${scenario.remaining}`} initialEntries={['/chat?project=Types&session=deleted']}>
          <I18nProvider><Harness /></I18nProvider>
        </MemoryRouter>,
      ))
      await act(async () => { assert.equal(await controls.deleteSession('deleted', project.id), true) })
      assert.equal(new URLSearchParams(route.split('?')[1]).get('session'), scenario.expected)
    }
  } finally {
    chatSessionApi.remove = originalRemove
    await act(async () => root.unmount())
    useProjectStore.setState({ projects: originalProjects.projects, activeProject: originalProjects.activeProject })
    useChatListStore.setState({ sessionsByProject: originalList.sessionsByProject })
    container.remove()
    await window.happyDOM.close()
  }
})

test('sidebar session deletion keeps failure visible and redirects the active conversation after retry', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalRemove = chatSessionApi.remove
  const originalProjects = useProjectStore.getState()
  const originalList = useChatListStore.getState()
  const project: Project = { id: 'project-1', name: 'My Project', path: '/tmp/project-1', steps: {}, workflows: [] }
  let controls!: ReturnType<typeof useSidebarSessionActions>
  let route = ''
  let navigationState: unknown
  let attempts = 0

  function Harness() {
    controls = useSidebarSessionActions()
    const location = useLocation()
    route = location.pathname + location.search
    navigationState = location.state
    return null
  }

  chatSessionApi.remove = async () => {
    attempts += 1
    if (attempts === 1) throw new Error('delete failed')
    return { success: true } as never
  }
  useProjectStore.setState({ projects: [project], activeProject: project })
  useChatListStore.setState({ sessionsByProject: { [project.id]: [
    { id: 'session-1', project_id: project.id, title: 'First' },
    { id: 'session-2', project_id: project.id, title: 'Second' },
  ] as never } })

  try {
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/chat?project=My%20Project&session=session-1']}>
        <I18nProvider><Harness /></I18nProvider>
      </MemoryRouter>,
    ))
    await act(async () => { assert.equal(await controls.deleteSession('session-1', project.id), false) })
    assert.equal(controls.sessionError, 'delete failed')
    assert.match(route, /session=session-1/)
    await act(async () => { assert.equal(await controls.deleteSession('session-1', project.id), true) })
    assert.equal(controls.sessionError, '')
    assert.match(route, /session=session-2/)
    assert.deepEqual(navigationState, { preserveNavigationDrawer: true })
    assert.equal(useChatListStore.getState().sessionsByProject[project.id]?.[0].id, 'session-2')
  } finally {
    chatSessionApi.remove = originalRemove
    await act(async () => root.unmount())
    useProjectStore.setState({ projects: originalProjects.projects, activeProject: originalProjects.activeProject })
    useChatListStore.setState({ sessionsByProject: originalList.sessionsByProject })
    container.remove()
    await window.happyDOM.close()
  }
})

test('sidebar session creation, rename and archive update the list and active route', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalCreate = chatSessionApi.create
  const originalRename = chatSessionApi.rename
  const originalArchive = chatSessionApi.setArchived
  const originalProjects = useProjectStore.getState()
  const originalList = useChatListStore.getState()
  const project: Project = { id: 'project-2', name: 'Another Project', path: '/tmp/project-2', steps: {}, workflows: [] }
  let controls!: ReturnType<typeof useSidebarSessionActions>
  let route = ''
  let createCalls = 0
  let releaseCreate!: () => void
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve })

  function Harness() {
    controls = useSidebarSessionActions()
    const location = useLocation()
    route = location.pathname + location.search
    return null
  }

  chatSessionApi.create = async () => {
    createCalls += 1
    await createGate
    return {
      id: 'session-created', project_id: project.id, title: 'New',
      workflow_id: null, engine: 'codex', model: null,
      message_count: 0, created_at: '', updated_at: '',
    } as never
  }
  chatSessionApi.rename = async (_sessionId, _projectId, title) => ({ title }) as never
  chatSessionApi.setArchived = async () => ({ success: true }) as never
  useProjectStore.setState({ projects: [project], activeProject: project })
  useChatListStore.setState({ sessionsByProject: { [project.id]: [] } })

  try {
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/chat?project=Another%20Project']}>
        <I18nProvider><Harness /></I18nProvider>
      </MemoryRouter>,
    ))
    let first!: Promise<void>
    await act(async () => {
      first = controls.createSession(project)
      await controls.createSession(project)
    })
    assert.equal(createCalls, 1)
    assert.equal(controls.creatingSession, true)
    await act(async () => { releaseCreate(); await first })
    assert.match(route, /session=session-created/)
    await act(async () => { await controls.renameSession('session-created', project.id, 'Renamed') })
    assert.equal(useChatListStore.getState().sessionsByProject[project.id]?.[0].title, 'Renamed')
    await act(async () => { await controls.archiveSession('session-created', project.id) })
    assert.doesNotMatch(route, /session=/)
    assert.equal(useChatListStore.getState().sessionsByProject[project.id]?.length, 0)
  } finally {
    releaseCreate()
    chatSessionApi.create = originalCreate
    chatSessionApi.rename = originalRename
    chatSessionApi.setArchived = originalArchive
    await act(async () => root.unmount())
    useProjectStore.setState({ projects: originalProjects.projects, activeProject: originalProjects.activeProject })
    useChatListStore.setState({ sessionsByProject: originalList.sessionsByProject })
    container.remove()
    await window.happyDOM.close()
  }
})
