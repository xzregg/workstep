import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const viewSource = fs.readFileSync(
  new URL('../src/components/TaskConversationMessage.tsx', import.meta.url),
  'utf8',
)
const detailSource = fs.readFileSync(
  new URL('../src/pages/TaskDetail.tsx', import.meta.url),
  'utf8',
)
const actionsSource = fs.readFileSync(
  new URL('../src/components/ReviewDecisionActions.tsx', import.meta.url),
  'utf8',
)
const reviewResultSource = fs.readFileSync(
  new URL('../src/components/TaskReviewResult.tsx', import.meta.url),
  'utf8',
)

test('人工审核的详情卡片和消息卡片都提供终止动作', () => {
  assert.equal((viewSource.match(/<ReviewDecisionActions\b/g) || []).length, 1)
  assert.match(reviewResultSource, /<ReviewDecisionActions\b/)
  assert.match(actionsSource, /onAction\('terminate'\)/)
  assert.match(actionsSource, /variant="danger"[\s\S]*t\('taskDetail\.terminate'\)/)
})

test('步骤进度保留后端任务步骤状态，审核动作才能读取 awaiting_review', () => {
  assert.match(detailSource, /return \{ \.\.\.taskStep, visualState \}/)
})
