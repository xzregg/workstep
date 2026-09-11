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
