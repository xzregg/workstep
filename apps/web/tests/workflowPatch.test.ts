import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyWorkflowPatch,
  changedStepIds,
} from '../src/utils/workflowPatch.ts'

const base = {
  nodes: [
    { id: 1, type: 'req', title: '需求' },
    { id: 2, type: 'dev', title: '开发' },
    { id: 3, type: 'publish', title: '发布' },
  ],
  connections: [
    { from: 1, fromPort: 0, to: 2, toPort: 0 },
    { from: 2, fromPort: 0, to: 3, toPort: 0 },
  ],
}

const patch = {
  upsertNodes: [
    { id: 2, type: 'dev', title: '开发v2' },
    { type: 'test', title: '测试' },
  ],
  removeNodeIds: [3],
}

test('applies every changed step when selection is null', () => {
  const merged = applyWorkflowPatch(base, patch, null)
  const titles = merged.nodes.map((node: any) => node.title)
  assert.deepEqual(titles, ['需求', '开发v2', '测试'])
  // Removed node's connections are dropped; 1->2 survives.
  assert.deepEqual(merged.connections, [{ from: 1, fromPort: 0, to: 2, toPort: 0 }])
})

test('applies only the selected step', () => {
  const merged = applyWorkflowPatch(base, patch, new Set([2]))
  const titles = merged.nodes.map((node: any) => node.title)
  // Only the dev rename lands; the new "test" step and the removal are skipped.
  assert.deepEqual(titles, ['需求', '开发v2', '发布'])
  assert.deepEqual(merged.connections, base.connections)
})

test('skips a step when it is not selected', () => {
  const merged = applyWorkflowPatch(base, patch, new Set([3]))
  const titles = merged.nodes.map((node: any) => node.title)
  assert.deepEqual(titles, ['需求', '开发'])
})

test('changedStepIds defaults to every reported step', () => {
  const ids = changedStepIds([
    { id: 2, key: 'dev', title: '开发', change: 'updated' },
    { id: 3, key: 'test', title: '测试', change: 'added' },
  ])
  assert.deepEqual([...ids].sort((a, b) => a - b), [2, 3])
})
