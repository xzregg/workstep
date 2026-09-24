import assert from 'node:assert/strict'
import test from 'node:test'
import { asyncQuestionsFromEvents, asyncQuestionAnswer } from '../src/utils/asyncQuestion.ts'

test('extracts Codex asynchronous questions from AG-UI events', () => {
  const questions = asyncQuestionsFromEvents([{
    type: 'CUSTOM',
    name: 'workstep.async_question',
    value: {
      source_item_id: 'call-1',
      questions: [{ title: '处理方式？', options: ['复制差异块', '逐行复制'] }],
    },
  }])

  assert.deepEqual(questions, [{
    sourceItemId: 'call-1',
    title: '处理方式？',
    options: ['复制差异块', '逐行复制'],
  }])
  assert.equal(asyncQuestionAnswer(questions[0], '复制差异块', 1), '复制差异块')
})

test('labels an answer when several questions share a message', () => {
  assert.equal(asyncQuestionAnswer({ sourceItemId: 'call-1', title: '范围？', options: [] }, '前端', 2), '范围？：前端')
})
