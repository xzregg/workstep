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

test('upserts task status messages instead of rendering eight rows for four tasks', () => {
  const plan = latestPlanFromEvents([{
    type: 'plan',
    data: {
      entries: [
        { taskId: '#1', content: '初始化项目环境', status: 'pending' },
        { taskId: '#2', content: '分析需求并输出方案', status: 'pending' },
        { taskId: '#3', content: '实现核心逻辑', status: 'pending' },
        { taskId: '#4', content: '收尾与总结', status: 'pending' },
        { taskId: '#1', content: '初始化项目环境', status: 'completed' },
        { taskId: '#2', content: '分析需求并输出方案', status: 'completed' },
        { taskId: '#3', content: '实现核心逻辑', status: 'completed' },
        { taskId: '#4', content: '收尾与总结', status: 'completed' },
      ],
    },
  }])

  assert.equal(plan?.total, 4)
  assert.equal(plan?.completed, 4)
  assert.deepEqual(plan?.entries.map((entry) => entry.content), [
    '初始化项目环境',
    '分析需求并输出方案',
    '实现核心逻辑',
    '收尾与总结',
  ])
})

test('deduplicates legacy task snapshots without task ids by normalized content', () => {
  const plan = latestPlanFromEvents([{
    type: 'plan',
    data: { entries: [
      { content: '实现核心逻辑', status: 'pending' },
      { content: '  实现核心逻辑  ', status: 'completed' },
    ] },
  }])

  assert.equal(plan?.total, 1)
  assert.equal(plan?.completed, 1)
})

test('folds numeric-only status rows back into their original task positions', () => {
  const plan = latestPlanFromEvents([{
    type: 'plan',
    data: { entries: [
      { content: '步骤 1:初始化任务看板', status: 'pending' },
      { content: '步骤 2:环境检查', status: 'pending' },
      { content: '步骤 3:输出中间结果', status: 'pending' },
      { content: '步骤 4:总结汇报', status: 'pending' },
      { content: '1', status: 'completed' },
      { content: '2', status: 'completed' },
      { content: '3', status: 'completed' },
      { content: '4', status: 'completed' },
    ] },
  }])

  assert.equal(plan?.total, 4)
  assert.equal(plan?.completed, 4)
  assert.deepEqual(plan?.entries.map((entry) => entry.content), [
    '步骤 1:初始化任务看板',
    '步骤 2:环境检查',
    '步骤 3:输出中间结果',
    '步骤 4:总结汇报',
  ])
})

test('keeps an out-of-range numeric task as a real plan item', () => {
  const plan = latestPlanFromEvents([{
    type: 'plan',
    data: { entries: [
      { content: '准备环境', status: 'pending' },
      { content: '9', status: 'completed' },
    ] },
  }])

  assert.equal(plan?.total, 2)
})

test('restores step details from streamed task creation arguments', () => {
  const plan = latestPlanFromEvents([
    {
      type: 'TOOL_CALL_CHUNK',
      toolCallId: 'create-1',
      delta: '{"subject":"环境检查",',
    },
    {
      type: 'TOOL_CALL_CHUNK',
      toolCallId: 'create-1',
      delta: '"description":"检查运行环境与依赖版本"}',
    },
    {
      type: 'TOOL_CALL_CHUNK',
      toolCallId: 'create-1',
      delta: '{"taskId":"1","status":"completed"}',
    },
    {
      type: 'CUSTOM',
      name: 'workstep.plan',
      value: { entries: [
        { content: '环境检查', status: 'completed' },
      ] },
    },
  ])

  assert.equal(plan?.entries[0].detail, '检查运行环境与依赖版本')
})

test('keeps step details when ordinal-only rows update the status', () => {
  const plan = latestPlanFromEvents([{
    type: 'plan',
    data: { entries: [
      { content: '环境检查', detail: '检查运行环境与依赖版本', status: 'pending' },
      { content: '1', status: 'completed' },
    ] },
  }])

  assert.deepEqual(plan?.entries, [{
    content: '环境检查',
    detail: '检查运行环境与依赖版本',
    priority: 'medium',
    status: 'completed',
  }])
})
