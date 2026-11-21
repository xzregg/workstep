import assert from 'node:assert/strict'
import test from 'node:test'
import { proposedPlanText } from '../src/utils/proposedPlanText'

test('only recognizes an outer proposal, leaving Markdown examples untouched', () => {
  for (const text of ['普通正文', '```xml\n<proposed_plan>\n示例\n</proposed_plan>\n```', '`<proposed_plan>`', '说明\n<proposed_plan>\n示例']) {
    assert.equal(proposedPlanText(text, true), undefined)
  }
  assert.deepEqual(proposedPlanText(' \n<proposed_plan>\n# 方案\n正文\n</proposed_plan>\n后续说明', false), {
    content: '\n# 方案\n正文\n', complete: true, trailing: '\n后续说明',
  })
})

test('buffers split delimiters while streaming and keeps an unfinished plan readable', () => {
  assert.deepEqual(proposedPlanText('<proposed_', true), { pending: true })
  assert.equal(proposedPlanText('<proposed_', false), undefined)
  const opening = '<proposed_plan>'
  const closing = '</proposed_plan>'
  for (let i = 0; i < closing.length; i++) {
    const result = proposedPlanText(`${opening}\n# 方案\n${closing.slice(0, i)}`, true)
    assert.deepEqual(result, { content: '\n# 方案\n', complete: false, trailing: '' })
  }
  assert.deepEqual(proposedPlanText(`${opening}\n# 未完成`, false), {
    content: '\n# 未完成', complete: false, trailing: '',
  })
})

test('closing tags inside fenced examples do not end the plan', () => {
  for (const fence of ['```', '~~~~']) {
    const body = `\n# 方案\n${fence}xml\n</proposed_plan>\n${fence}\n正文\n`
    assert.deepEqual(proposedPlanText(`<proposed_plan>${body}</proposed_plan>`, false), {
      content: body, complete: true, trailing: '',
    })
  }
})
