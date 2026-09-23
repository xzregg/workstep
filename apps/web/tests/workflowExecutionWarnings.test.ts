import assert from 'node:assert/strict'
import test from 'node:test'

import { findWorkflowExecutionWarnings } from '../src/utils/workflowExecutionWarnings.ts'

test('warns only when an output from a feedback input is required by the verifier', () => {
  const workflow = {
    nodes: [
      {
        id: 1, title: '前端开发',
        inputs: [
          { name: '功能开发', outputs: [{ name: '开发文档' }, { name: '分支名' }] },
          { name: 'BUG 修复', outputs: [{ name: '修复列表' }] },
        ],
        outputs: [{ name: '开发文档' }, { name: '分支名' }, { name: '修复列表' }],
      },
      { id: 2, title: '测试', inputs: [{ name: '前端功能测试' }], outputs: [{ name: 'Bug 列表' }] },
      {
        id: 3, title: '后端开发',
        inputs: [{ name: '开发', outputs: [{ name: 'API 文档' }] }, { name: 'BUG 修复', outputs: [{ name: '修复列表' }] }],
        outputs: [{ name: 'API 文档' }, { name: '修复列表' }],
      },
    ],
    connections: [
      { from: 1, fromPort: 0, to: 2, toPort: 0, kind: 'solid' },
      { from: 1, fromPort: 1, to: 2, toPort: 0, kind: 'solid' },
      { from: 1, fromPort: 2, to: 2, toPort: 0, kind: 'solid' },
      { from: 2, fromPort: 0, to: 1, toPort: 1, kind: 'dashed' },
      { from: 3, fromPort: 1, to: 2, toPort: 0, kind: 'solid' },
      { from: 2, fromPort: 0, to: 3, toPort: 1, kind: 'dashed' },
    ],
  }

  assert.deepEqual(findWorkflowExecutionWarnings(workflow), [{ target: '测试' }])
})

test('ignores normal multi-output links and feedback on unrelated input ports', () => {
  const workflow = {
    nodes: [
      {
        id: 1, title: '开发',
        inputs: [
          { name: '开发', outputs: [{ name: '文档' }, { name: '规范' }] },
          { name: '修复', outputs: [{ name: '修复列表' }] },
        ],
        outputs: [{ name: '文档' }, { name: '规范' }, { name: '修复列表' }],
      },
      { id: 2, title: '测试', inputs: [{ name: '文档' }] },
      { id: 3, title: '其它反馈' },
    ],
    connections: [
      { from: 1, fromPort: 0, to: 2, toPort: 0, kind: 'solid' },
      { from: 1, fromPort: 1, to: 2, toPort: 0, kind: 'solid' },
      { from: 3, fromPort: 0, to: 1, toPort: 1, kind: 'dashed' },
    ],
  }

  assert.deepEqual(findWorkflowExecutionWarnings(workflow), [])
})
