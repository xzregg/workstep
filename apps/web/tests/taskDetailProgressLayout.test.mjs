import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/TaskDetailView.tsx', import.meta.url), 'utf8')
const pageSource = await readFile(new URL('../src/pages/TaskDetail.tsx', import.meta.url), 'utf8')

test('places the scheduled start input beside the description save actions', () => {
  const actionInputPos = source.indexOf('{descriptionEditorLeadingActions}')
  const cancelPos = source.indexOf("{t('common.cancel')}", actionInputPos)

  assert.ok(actionInputPos >= 0, 'scheduled start input slot missing')
  assert.ok(cancelPos > actionInputPos, 'scheduled start input should precede cancel and save')
  assert.match(
    pageSource,
    /descriptionEditorLeadingActions=\{editingDescription && task\.scheduled_start_state && taskNotStarted/,
  )
  assert.doesNotMatch(pageSource, /scheduleControl=/)

  const saveDescription = pageSource.slice(
    pageSource.indexOf('const saveDescription'),
    pageSource.indexOf('const openPromptEditor'),
  )
  assert.match(saveDescription, /updateScheduledStart/)
})

test('gives the scheduled start editor enough width for its date and time', () => {
  assert.match(
    pageSource,
    /display: 'flex', alignItems: 'center', gap: 8, width: 380, maxWidth: '100%'/,
  )
})

test('shows the scheduled execution time beside the description heading', () => {
  const descriptionPos = source.indexOf("{t('taskDetail.description')}")
  const scheduledTimePos = source.indexOf('{scheduledStartText}', descriptionPos)
  const editPos = source.indexOf("aria-label={t('taskDetail.editDescriptionAria')}", descriptionPos)

  assert.ok(scheduledTimePos > descriptionPos, 'scheduled execution time missing beside description')
  assert.ok(editPos > scheduledTimePos, 'edit action should follow the scheduled execution time')
  assert.match(pageSource, /scheduledStartText=\{formatScheduledStart\(task\.scheduled_start_at\)\}/)
})

test('uses the dedicated stage progress graph component', () => {
  assert.match(source, /import TaskStageProgressGraph from '\.\/TaskStageProgressGraph'/)
  assert.match(source, /<TaskStageProgressGraph[\s\S]*stages=\{stages\}[\s\S]*stageProgress=\{stageProgress\}/)
  assert.doesNotMatch(source, /\/\* Progress timeline \*\//)
})

test('shows pending outputs before the file type and only opens generated files', () => {
  const outputReadyPos = source.indexOf('const outputReady = Boolean(outArtifact)')
  const statusPos = source.indexOf("t('taskDetail.outputDone')", outputReadyPos)
  const typePos = source.indexOf('{out.type}', statusPos)

  assert.ok(outputReadyPos >= 0, 'output readiness guard missing')
  assert.ok(statusPos > outputReadyPos, 'output status badge missing')
  assert.ok(typePos > statusPos, 'output status badge should precede the file type')
  assert.match(source, /outputReady &&[\s\S]*\{t\('common\.open'\)\}/)
  assert.match(source, /role=\{outputReady \? 'button' : undefined\}/)
  assert.match(source, /cursor: outputReady \? 'pointer' : 'default'/)
})
