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
const taskDetailView = await readFile(
  new URL('../src/components/TaskDetailView.tsx', import.meta.url),
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

test('task detail keeps review actions in content and has no duplicate footer action bar', () => {
  assert.doesNotMatch(taskDetailPage, /task-detail-footer-actions/)
  assert.doesNotMatch(taskDetailPage, /primaryAction/)
  assert.doesNotMatch(chatHelpers, /export function resolveTaskDetailAdvanceState/)
  assert.doesNotMatch(taskDetail, /resolveTaskDetailAdvanceState/)
  assert.doesNotMatch(sharedView, /resolveTaskDetailAdvanceState/)
  assert.doesNotMatch(sharedView, /primaryAction/)
  assert.match(sharedView, /chatEnabled=\{interactive\}/)
})

test('task detail close control is the final header action', async () => {
  const header = await readFile(new URL('../src/components/TaskDetailHeader.tsx', import.meta.url), 'utf8')
  const titleIndex = header.indexOf('{task.title}')
  const closeIndex = header.indexOf('aria-label={t(\'common.close\')}')

  assert.ok(titleIndex >= 0)
  assert.ok(closeIndex > titleIndex)
  assert.match(header, /<Icon name="x"/)
})
