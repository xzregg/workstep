import assert from 'node:assert/strict'
import test from 'node:test'

import type { Project } from '../src/api/client.ts'
import { useProjectStore } from '../src/stores/projectStore.ts'

const project = (id: string): Project => ({
  id,
  path: `/tmp/${id}`,
  name: id,
  steps: {},
  workflows: [{ id: `${id}-workflow`, name: 'Default', is_default: true, nodeCount: 0 }],
})

test('default workspace is selected only when no project is selected and does not create a workflow', async () => {
  const originalFetch = globalThis.fetch
  const runtime = { ...project('runtime'), name: 'Runtime', is_default_workspace: true, workflows: [] }
  const ordinary = project('ordinary')
  globalThis.fetch = async () => Response.json({ projects: [ordinary, runtime] })
  try {
    useProjectStore.setState({ projects: [], activeProject: null, activeWorkflowId: null })
    await useProjectStore.getState().fetchProjects()
    assert.equal(useProjectStore.getState().activeProject?.id, runtime.id)
    assert.equal(useProjectStore.getState().activeWorkflowId, null)
    useProjectStore.getState().setActiveProject(ordinary)
    await useProjectStore.getState().fetchProjects()
    assert.equal(useProjectStore.getState().activeProject?.id, ordinary.id)
  } finally { globalThis.fetch = originalFetch }
})

test('renaming the default workspace updates active metadata while preserving its identity', async () => {
  const originalFetch = globalThis.fetch
  const runtime = { ...project('runtime'), is_default_workspace: true, workflows: [] }
  globalThis.fetch = async () => Response.json({ path: runtime.path, name: '我的工作台' })
  useProjectStore.setState({ projects: [runtime], activeProject: runtime, activeWorkflowId: null })
  try {
    await useProjectStore.getState().renameProject(runtime.path, '我的工作台')
    assert.equal(useProjectStore.getState().activeProject?.name, '我的工作台')
    assert.equal(useProjectStore.getState().activeProject?.id, runtime.id)
    assert.equal(useProjectStore.getState().activeProject?.is_default_workspace, true)
  } finally { globalThis.fetch = originalFetch }
})

test('creating an empty project clears the previous workflow selection without creating a workflow', async () => {
  const previous = project('existing')
  const blank: Project = { id: 'blank', path: '/tmp/blank', name: 'blank', steps: {}, workflows: [] }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), '/api/project/init')
    assert.equal(init?.method, 'POST')
    return Response.json(blank)
  }
  useProjectStore.setState({ projects: [previous], activeProject: previous, activeWorkflowId: 'existing-workflow' })
  try {
    const created = await useProjectStore.getState().initProject(blank.path)
    useProjectStore.getState().setActiveProject(created)
    assert.deepEqual(useProjectStore.getState().activeProject, blank)
    assert.equal(useProjectStore.getState().activeWorkflowId, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('opening an existing project restores workflow selection without duplicating it', async () => {
  const restored = project('existing')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify(restored), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
  useProjectStore.setState({ projects: [restored], activeProject: null, activeWorkflowId: null })
  try {
    const opened = await useProjectStore.getState().initProject(restored.path)
    useProjectStore.getState().setActiveProject(opened)
    assert.deepEqual(useProjectStore.getState().projects, [restored])
    assert.equal(useProjectStore.getState().activeWorkflowId, 'existing-workflow')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('deleting the active project selects the next registered project', async () => {
  const first = project('first')
  const second = project('second')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), '/api/project/first')
    assert.equal(init?.method, 'DELETE')
    return new Response(JSON.stringify({ deleted: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  useProjectStore.setState({
    projects: [first, second],
    activeProject: first,
    activeWorkflowId: first.workflows[0].id,
  })

  try {
    const next = await useProjectStore.getState().deleteProject(first.id)
    assert.equal(next, second)
    assert.deepEqual(useProjectStore.getState().projects, [second])
    assert.equal(useProjectStore.getState().activeProject, second)
    assert.equal(useProjectStore.getState().activeWorkflowId, second.workflows[0].id)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('deleting the last active project clears the selection', async () => {
  const only = project('only')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ deleted: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
  useProjectStore.setState({
    projects: [only],
    activeProject: only,
    activeWorkflowId: only.workflows[0].id,
  })

  try {
    const next = await useProjectStore.getState().deleteProject(only.id)
    assert.equal(next, null)
    assert.deepEqual(useProjectStore.getState().projects, [])
    assert.equal(useProjectStore.getState().activeProject, null)
    assert.equal(useProjectStore.getState().activeWorkflowId, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('concurrent project loads share the in-flight request and both await its result', async () => {
  const loaded = project('loaded')
  const originalFetch = globalThis.fetch
  let resolveFetch!: (response: Response) => void
  let fetchCount = 0
  globalThis.fetch = async () => {
    fetchCount += 1
    return new Promise<Response>((resolve) => { resolveFetch = resolve })
  }
  useProjectStore.setState({ projects: [], activeProject: null, loading: false })

  try {
    const first = useProjectStore.getState().fetchProjects()
    const second = useProjectStore.getState().fetchProjects()
    let secondSettled = false
    void second.then(() => { secondSettled = true })
    await Promise.resolve()
    assert.equal(secondSettled, false)
    resolveFetch(new Response(JSON.stringify({ projects: [loaded] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    await Promise.all([first, second])

    assert.equal(fetchCount, 1)
    assert.deepEqual(useProjectStore.getState().projects, [loaded])
  } finally {
    globalThis.fetch = originalFetch
  }
})

const projectWithFlows = (id: string, workflowNames: string[]): Project => ({
  id,
  path: `/tmp/${id}`,
  name: id,
  steps: {},
  workflows: workflowNames.map((name, index) => ({
    id: `${id}-wf-${index}`,
    name,
    is_default: index === 0,
    nodeCount: 0,
  })),
})

test('failed project loads preserve cache and expose an error cleared by retry', async () => {
  const originalFetch = globalThis.fetch
  const cached = project('cached')
  useProjectStore.setState({ projects: [cached], activeProject: cached })
  try {
    globalThis.fetch = async () => Response.json({ detail: '设备连接失败' }, { status: 502 })
    await useProjectStore.getState().fetchProjects()
    assert.equal(useProjectStore.getState().loadError, '设备连接失败')
    assert.deepEqual(useProjectStore.getState().projects, [cached])
    globalThis.fetch = async () => Response.json({ projects: [cached] })
    await useProjectStore.getState().fetchProjects()
    assert.equal(useProjectStore.getState().loadError, null)
  } finally { globalThis.fetch = originalFetch }
})

test('catalog changes during loading queue one follow-up and hydrate the remote default workflow', async () => {
  const originalFetch = globalThis.fetch
  const remote = { ...project('remote:p'), type: 'remote' as const, workflows: [] }
  useProjectStore.setState({ projects: [remote], activeProject: remote, activeWorkflowId: null })
  let resolveFetch!: (response: Response) => void
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) return new Promise<Response>(resolve => { resolveFetch = resolve })
    return Response.json({ projects: [{ ...project('remote:p'), type: 'remote' }] })
  }
  try {
    const loading = useProjectStore.getState().fetchProjects()
    useProjectStore.getState().refreshProjects()
    useProjectStore.getState().refreshProjects()
    resolveFetch(Response.json({ projects: [remote] }))
    await loading
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(calls, 2)
    assert.equal(useProjectStore.getState().activeWorkflowId, 'remote:p-workflow')
  } finally { globalThis.fetch = originalFetch }
})

test('reorderWorkflows persists the new order and updates local state', async () => {
  const proj = projectWithFlows('reorder', ['One', 'Two', 'Three'])
  const orderedIds = ['reorder-wf-2', 'reorder-wf-0', 'reorder-wf-1']
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), '/api/workflow/reorder?project_id=reorder')
    assert.equal(init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(init?.body)), { ordered_ids: orderedIds })
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  useProjectStore.setState({ projects: [proj], activeProject: proj })

  try {
    await useProjectStore.getState().reorderWorkflows(proj.id, orderedIds)
    const names = useProjectStore.getState().projects[0].workflows.map((w) => w.name)
    assert.deepEqual(names, ['Three', 'One', 'Two'])
    assert.deepEqual(
      useProjectStore.getState().activeProject?.workflows.map((w) => w.name),
      ['Three', 'One', 'Two'],
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})


test('remote snapshot events update only that project without issuing HTTP requests', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('unexpected request') }
  const local = project('local')
  const remote = { ...project('remote:event'), type: 'remote' as const, workflows: [] }
  useProjectStore.setState({ projects: [local, remote], activeProject: remote, activeWorkflowId: null })
  try {
    useProjectStore.getState().applyRemoteProject({ ...remote, workflows: project(remote.id).workflows, connection_status: 'connected' })
    assert.equal(calls, 0)
    assert.equal(useProjectStore.getState().projects[0], local)
    assert.equal(useProjectStore.getState().activeWorkflowId, 'remote:event-workflow')
  } finally { globalThis.fetch = originalFetch }
})

test('a newer remote event wins over an older full catalog response', async () => {
  const originalFetch = globalThis.fetch
  const remote = { ...project('remote:race'), type: 'remote' as const, workflows: [] }
  useProjectStore.setState({ projects: [remote], activeProject: remote, activeWorkflowId: null })
  let resolveFetch!: (response: Response) => void
  globalThis.fetch = async () => new Promise<Response>(resolve => { resolveFetch = resolve })
  try {
    const pending = useProjectStore.getState().fetchProjects()
    useProjectStore.getState().applyRemoteProject({ ...remote, workflows: project(remote.id).workflows })
    resolveFetch(Response.json({ projects: [remote] }))
    await pending
    assert.equal(useProjectStore.getState().projects[0].workflows.length, 1)
    assert.equal(useProjectStore.getState().activeWorkflowId, 'remote:race-workflow')
  } finally { globalThis.fetch = originalFetch }
})
