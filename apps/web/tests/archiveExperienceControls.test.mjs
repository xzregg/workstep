import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const taskListSource = await readFile(new URL('../src/pages/TaskList.tsx', import.meta.url), 'utf8')
const archiveSource = await readFile(new URL('../src/components/ArchiveExperienceDialog.tsx', import.meta.url), 'utf8')
const confirmDialogSource = await readFile(new URL('../src/components/ConfirmDialog.tsx', import.meta.url), 'utf8')
const progressSource = await readFile(new URL('../src/components/ArchiveExperienceProgress.tsx', import.meta.url), 'utf8')

test('archive experience dialog offers a direct archive action without Memory', () => {
  assert.match(confirmDialogSource, /secondaryText\?: string/)
  assert.match(archiveSource, /secondaryText=\{phase/)
  assert.match(archiveSource, /: t\('taskList\.archiveExperienceDirectArchive'\)\}/)
  assert.match(archiveSource, /await archiveDirectly\(task\.id, projectId\)/)
  assert.ok(
    confirmDialogSource.indexOf('{confirmText ??')
      < confirmDialogSource.indexOf('{secondaryText}'),
    'direct archive should be the rightmost action',
  )
})

test('archive experience waiting state shows elapsed time', () => {
  assert.match(progressSource, /formatDuration\(elapsedMs, t\)/)
  assert.match(progressSource, /setInterval/)
})

test('every non-running active task can enter the archive experience flow', () => {
  assert.ok(
    taskListSource.includes("{!showArchived && status !== 'running' && ("),
    'archive action should be available for every non-running active task',
  )
  assert.ok(
    !taskListSource.includes("{!showArchived && taskCompleted && isLastLane && status !== 'running' && ("),
    'archive action should not require completion in the last lane',
  )
})

test('reopening archive restores the previous draft directly into review', () => {
  assert.match(archiveSource, /getDraft\(task\.id, projectId\)/)
  assert.match(archiveSource, /setPhase\(draft\.has_experience \? 'review' : 'empty'\)/)
  assert.match(archiveSource, /setHistoryMessage\(\{/)
  assert.match(archiveSource, /events: draft\.events/)
  assert.match(archiveSource, /progressMessage \|\| historyMessage/)
})

test('an empty verified result archives without recording an experience', () => {
  assert.match(archiveSource, /phase === 'empty'/)
  assert.match(archiveSource, /await confirmArchive\(task\.id, projectId, ''\)/)
  assert.match(archiveSource, /fallbackContent=\{t\('taskList\.archiveExperienceEmptyResult'\)\}/)
  assert.match(progressSource, /fallbackContent\?: string/)
})
