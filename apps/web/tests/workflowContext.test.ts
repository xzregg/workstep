import assert from 'node:assert/strict'
import test from 'node:test'

import { selectWorkflowTurnContext } from '../src/utils/workflowContext.ts'

const steps = {
  nodes: [{ id: 1, type: 'req', title: '需求' }],
  connections: [],
}

test('injects title and canvas on the first workflow edit turn', () => {
  const context = selectWorkflowTurnContext('发布流程', steps, null)
  assert.equal(context.mode, 'initial')
  assert.equal(context.workflowName, '发布流程')
  assert.deepEqual(context.steps, steps)
})

test('omits unchanged canvas and reinjects changed canvas', () => {
  const first = selectWorkflowTurnContext('发布流程', steps, null)
  const unchanged = selectWorkflowTurnContext('发布流程', steps, first.snapshot)
  assert.equal(unchanged.mode, 'none')
  assert.equal(unchanged.steps, undefined)

  const changedSteps = { ...steps, nodes: [...steps.nodes, { id: 2, type: 'test', title: '测试' }] }
  const changed = selectWorkflowTurnContext('发布流程', changedSteps, first.snapshot)
  assert.equal(changed.mode, 'canvas_updated')
  assert.deepEqual(changed.steps, changedSteps)
})
