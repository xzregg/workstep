import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const taskListSource = await readFile(new URL('../src/pages/TaskList.tsx', import.meta.url), 'utf8')
const confirmDialogSource = await readFile(new URL('../src/components/ConfirmDialog.tsx', import.meta.url), 'utf8')
const progressSource = await readFile(new URL('../src/components/ArchiveExperienceProgress.tsx', import.meta.url), 'utf8')

test('archive experience dialog offers a direct archive action without Memory', () => {
  assert.match(confirmDialogSource, /secondaryText\?: string/)
  assert.match(taskListSource, /secondaryText=\{archiveExperiencePhase/)
  assert.match(taskListSource, /: t\('taskList\.archiveExperienceDirectArchive'\)\}/)
  assert.match(taskListSource, /await archiveTask\(taskId, activeProject\.id\)/)
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
  assert.match(taskListSource, /await getArchiveExperienceDraft\(taskId, activeProject\.id\)/)
  assert.match(taskListSource, /setArchiveExperiencePhase\(draft\.has_experience \? 'review' : 'empty'\)/)
  assert.match(taskListSource, /setArchiveExperienceHistory\(\{/)
  assert.match(taskListSource, /events: draft\.events/)
  assert.match(taskListSource, /archiveProgressMessage \|\| archiveExperienceHistory/)
})

test('an empty verified result archives without recording an experience', () => {
  assert.match(taskListSource, /archiveExperiencePhase === 'empty'/)
  assert.match(taskListSource, /await confirmArchiveExperience\(taskId, activeProject\.id, ''\)/)
  assert.match(taskListSource, /fallbackContent=\{t\('taskList\.archiveExperienceEmptyResult'\)\}/)
  assert.match(progressSource, /fallbackContent\?: string/)
})
