import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveTaskCreationErrors } from '../src/utils/taskCreationErrors.js'

test('shows a missing task title message only beside the title field', () => {
  assert.deepEqual(
    resolveTaskCreationErrors('请先输入任务标题', '请先输入任务标题'),
    {
      titleError: '请先输入任务标题',
      panelError: '',
    },
  )
})

test('keeps an unrelated task creation error in the panel', () => {
  assert.deepEqual(
    resolveTaskCreationErrors('', '创建任务失败'),
    {
      titleError: '',
      panelError: '创建任务失败',
    },
  )
})
