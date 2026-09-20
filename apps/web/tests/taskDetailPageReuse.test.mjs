import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const taskDetailPage = await readFile(
  new URL('../src/components/TaskDetailPage.tsx', import.meta.url),
  'utf8',
)
const taskDetail = await readFile(
  new URL('../src/pages/TaskDetail.tsx', import.meta.url),
  'utf8',
)
const sharedView = await readFile(
  new URL('../src/pages/SharedTaskView.tsx', import.meta.url),
  'utf8',
)
const chatHelpers = await readFile(
  new URL('../src/pages/taskDetailChat.ts', import.meta.url),
  'utf8',
)

test('task detail page is the single composition used by popup and share', () => {
  assert.match(taskDetailPage, /TaskDetailView/)
  assert.match(taskDetail, /from '\.\.\/components\/TaskDetailPage'/)
  assert.match(sharedView, /from '\.\.\/components\/TaskDetailPage'/)
  assert.match(taskDetail, /<TaskDetailPage/)
  assert.match(sharedView, /<TaskDetailPage/)
})

test('share renders the shared detail page instead of a parallel detail tree', () => {
  assert.doesNotMatch(sharedView, /import TaskDetailView/)
  assert.doesNotMatch(sharedView, /<TaskDetailView/)
  assert.match(taskDetailPage, /ArtifactPreview/)
  assert.match(taskDetailPage, /previewArtifact/)
  assert.match(taskDetailPage, /onCloseArtifactPreview/)
})

test('owner detail derives its advance action while shares stay display-only', () => {
  assert.match(chatHelpers, /export function resolveTaskDetailAdvanceState/)
  assert.match(taskDetail, /resolveTaskDetailAdvanceState/)
  assert.doesNotMatch(sharedView, /resolveTaskDetailAdvanceState/)
  assert.doesNotMatch(sharedView, /primaryAction/)
  assert.doesNotMatch(sharedView, /onReviewAction/)
  assert.match(sharedView, /readOnly/)
  assert.match(sharedView, /chatEnabled=\{interactive\}/)
})
