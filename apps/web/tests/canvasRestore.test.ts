import assert from 'node:assert/strict'
import test from 'node:test'

import { cloneCanvasSteps } from '../src/utils/canvasRestore.ts'

test('canvas restore snapshot is isolated from later canvas mutations', () => {
  const current = {
    nodes: [{ nodeId: 'draft', data: { label: '应用前' } }],
    connections: [{ from: 'draft', to: 'review' }],
  }

  const snapshot = cloneCanvasSteps(current)
  current.nodes[0].data.label = '应用后又编辑'
  current.connections.push({ from: 'review', to: 'publish' })

  assert.deepEqual(snapshot, {
    nodes: [{ nodeId: 'draft', data: { label: '应用前' } }],
    connections: [{ from: 'draft', to: 'review' }],
  })
})
