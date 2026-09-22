import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const viewSource = fs.readFileSync(
  new URL('../src/components/TaskDetailView.tsx', import.meta.url),
  'utf8',
)
const detailSource = fs.readFileSync(
  new URL('../src/pages/TaskDetail.tsx', import.meta.url),
  'utf8',
)

test('人工审核的详情卡片和消息卡片都提供终止动作', () => {
  assert.equal((viewSource.match(/onReviewAction\?\.\('terminate'/g) || []).length, 2)
  assert.match(viewSource, /variant="danger"[\s\S]*t\('taskDetail\.terminate'\)/)
})

test('任务详情允许把 terminate 决策发送给后端', () => {
  assert.match(
    detailSource,
    /decision: 'approve' \| 'reject' \| 'force-approve' \| 'terminate'/,
  )
})

test('步骤进度保留后端任务步骤状态，审核动作才能读取 awaiting_review', () => {
  assert.match(detailSource, /return \{ \.\.\.taskStep, visualState \}/)
})
