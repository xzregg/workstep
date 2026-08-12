import assert from 'node:assert/strict'
import test from 'node:test'

import { latestPlanFromEvents, mergePlanEvents } from '../src/utils/plan.ts'

test('uses the latest ACP plan snapshot and derives progress', () => {
  const plan = latestPlanFromEvents([
    { type: 'plan', data: { entries: [
      { content: '旧计划', priority: 'low', status: 'pending' },
    ] } },
    { type: 'text_delta', data: { delta: 'working' } },
    { type: 'plan', data: { explanation: '实现中', entries: [
      { content: '分析代码', priority: 'high', status: 'completed' },
      { content: '实现功能', priority: 'medium', status: 'in_progress' },
      { content: '运行测试', priority: 'medium', status: 'pending' },
    ] } },
  ])

  assert.deepEqual(plan, {
    explanation: '实现中',
    entries: [
      { content: '分析代码', priority: 'high', status: 'completed' },
      { content: '实现功能', priority: 'medium', status: 'in_progress' },
      { content: '运行测试', priority: 'medium', status: 'pending' },
    ],
    completed: 1,
    total: 3,
  })
})

test('keeps the persisted plan until a newer live snapshot arrives', () => {
  const persisted = [{ type: 'plan', data: { entries: [
    { content: '继续执行', priority: 'medium', status: 'in_progress' },
  ] } }]
  const live = [{ type: 'text_delta', data: { delta: 'working' } }]

  assert.deepEqual(
    mergePlanEvents(persisted, live).map((event) => event.type),
    ['plan', 'text_delta'],
  )
})
