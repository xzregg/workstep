import assert from 'node:assert/strict'
import test from 'node:test'

import type { Project } from '../src/api/client.ts'
import { resolveCanvasProject } from '../src/utils/canvasProjectLoad.ts'

const project = (steps: unknown): Project => ({
  id: '164938b7',
  name: 'demo',
  path: '/tmp/demo',
  steps,
  workflows: [
    { id: 'default', name: 'default', is_default: true, nodeCount: 1 },
    { id: 'e3606e86', name: 'selected', is_default: false, nodeCount: 1 },
  ],
})

test('canvas reuses the active project without refreshing the project list', async () => {
  const selected = project({ nodes: [{ type: 'selected' }] })
  const staleListProject = project({ nodes: [{ type: 'default' }] })
  let refreshCalls = 0

  const resolved = await resolveCanvasProject({
    projectName: 'demo',
    activeProject: selected,
    projects: [staleListProject],
    refreshProjects: async () => { refreshCalls += 1 },
    getProjects: () => [staleListProject],
  })

  assert.equal(refreshCalls, 0)
  assert.equal(resolved, selected)
})

test('canvas refreshes projects only when the requested project is missing', async () => {
  const loaded = project({ nodes: [{ type: 'default' }] })
  let refreshCalls = 0

  const resolved = await resolveCanvasProject({
    projectName: 'demo',
    activeProject: null,
    projects: [],
    refreshProjects: async () => { refreshCalls += 1 },
    getProjects: () => [loaded],
  })

  assert.equal(refreshCalls, 1)
  assert.equal(resolved, loaded)
})
