import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveTaskLane } from '../src/pages/taskListLane.ts'

const lanes = [
  { key: 'write', label: '编写', color: 'gray' },
  { key: 'review', label: '审校', color: 'gray' },
  { key: 'publish', label: '交付', color: 'gray' },
]

test('全部阶段完成时按工作流 Key 定位到最后阶段', () => {
  const task = {
    // 后端查询可能按索引返回，不保证工作流顺序。
    steps: [
      { step_key: 'publish', status: 'passed' },
      { step_key: 'review', status: 'passed' },
      { step_key: 'write', status: 'passed' },
    ],
  }

  assert.equal(deriveTaskLane(task, lanes), 'publish')
})

test('运行中状态仍优先于已完成阶段', () => {
  const task = {
    steps: [
      { step_key: 'publish', status: 'pending' },
      { step_key: 'write', status: 'passed' },
      { step_key: 'review', status: 'running' },
    ],
  }

  assert.equal(deriveTaskLane(task, lanes), 'review')
})

test('流程回退后落在最近实际执行的阶段，而不是工作流最后一列', () => {
  const task = {
    steps: [
      { step_key: 'publish', status: 'passed', ended_at: '2026-09-21T10:00:00Z' },
      { step_key: 'review', status: 'passed', ended_at: '2026-09-21T11:00:00Z' },
      { step_key: 'write', status: 'passed', ended_at: '2026-09-21T12:00:00Z' },
    ],
  }

  assert.equal(deriveTaskLane(task, lanes), 'write')
})
