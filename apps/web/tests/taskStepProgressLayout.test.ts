import assert from 'node:assert/strict'
import test from 'node:test'
import { computeGraphLayout, nodeRect, routeEdge } from '../src/components/taskStepProgressLayout'

test('progress layout places parallel steps together and rework links remain dashed', () => {
  const layout = computeGraphLayout([
    { key: 'start', label: 'Start', color: '#000' },
    { key: 'left', label: 'Left', color: '#000', dependsOn: ['start'] },
    { key: 'right', label: 'Right', color: '#000', dependsOn: ['start'] },
    { key: 'review', label: 'Review', color: '#000', dependsOn: ['left', 'right'], reworkDependsOn: ['start'] },
  ])
  assert.deepEqual(layout.columnOf, [0, 1, 1, 2])
  assert.deepEqual(layout.rowOf, [0, 0, 1, 0])
  assert.equal(layout.dashedDependencies.has('0->3'), true)
})

test('progress edge geometry connects the sides of separated cards', () => {
  const first = nodeRect({ column: 0, row: 0 }, 100)
  const second = nodeRect({ column: 1, row: 0 }, 100)
  const edge = routeEdge(first, second)
  assert.equal(edge.startX, first.left + first.width)
  assert.equal(edge.endX, second.left)
  assert.match(edge.path, /^M /)
})
