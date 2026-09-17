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

test('shows the status badge above the stage name', () => {
  const iconPos = source.indexOf('{/* Dot */}')
  const statusPos = source.indexOf("visualState !== 'pending'")
  const namePos = source.indexOf('height: 28', statusPos)
  assert.ok(iconPos >= 0, 'icon row missing')
  assert.ok(statusPos > iconPos, 'status badge above the name missing')
  assert.ok(namePos > statusPos, 'name slot after status missing')
  const statusBlock = source.slice(statusPos, namePos)
  assert.match(statusBlock, /STAGE_STATE_LABEL_KEYS\[visualState\]/)
  const roundPos = source.indexOf('height: 20', namePos)
  const nameRow = source.slice(namePos, roundPos)
  assert.match(nameRow, /stage\.label/)
  assert.doesNotMatch(nameRow, /STAGE_STATE_LABEL_KEYS/)
})

test('keeps name, round and time rows in fixed slots', () => {
  assert.match(source, /height: 28,\s+marginTop: 8,\s+display: 'flex',\s+alignItems: 'center',\s+justifyContent: 'center'/)
  assert.match(source, /height: 20,\s+marginTop: 2,\s+display: 'flex',\s+alignItems: 'center',\s+justifyContent: 'center'/)
  assert.match(source, /minHeight: 32,\s+marginTop: 2,\s+display: 'flex',\s+flexDirection: 'column',\s+alignItems: 'center',\s+gap: 2/)
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
