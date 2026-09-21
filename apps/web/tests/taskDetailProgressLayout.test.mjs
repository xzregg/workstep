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

test('places stage input and output before the stage prompt', () => {
  const ioPos = source.indexOf("{t('taskDetail.stageIo')}")
  const promptPos = source.indexOf("{t('taskDetail.stagePrompt')}")

  assert.ok(ioPos >= 0, 'stage input and output section missing')
  assert.ok(promptPos > ioPos, 'stage input and output should precede the stage prompt')
})

test('keeps the output file type beside its name and only opens generated files', () => {
  const outputReadyPos = source.indexOf('const outputReady = Boolean(outArtifact)')
  const namePos = source.indexOf('{out.name}', outputReadyPos)
  const typePos = source.indexOf('{out.type}', namePos)
  const statusPos = source.indexOf("t('taskDetail.outputDone')", outputReadyPos)

  assert.ok(outputReadyPos >= 0, 'output readiness guard missing')
  assert.ok(namePos > outputReadyPos, 'output name missing')
  assert.ok(typePos > namePos, 'output file type should follow the output name')
  assert.ok(statusPos > outputReadyPos, 'output status badge missing')
  assert.ok(statusPos > typePos, 'output status badge should follow the file type')
  assert.match(source, /outputReady &&[\s\S]*\{t\('common\.open'\)\}/)
  assert.match(source, /role=\{outputReady \? 'button' : undefined\}/)
  assert.match(source, /cursor: outputReady \? 'pointer' : 'default'/)
})

test('shows artifact round status and modified time in stage IO rows', () => {
  assert.match(source, /const formatArtifactUpdatedAt = useCallback/)
  assert.match(source, /return \[\.\.\.rounds\]\.sort\(\(a, b\) => a - b\)/)
  assert.match(source, /currentStageArtifactRounds\[currentStageArtifactRounds\.length - 1\]/)
  assert.match(source, /role="tablist"/)
  assert.match(source, /setSelectedIoRound\(round\)/)
  assert.match(source, /const inputArtifact = findArtifact/)
  assert.match(source, /const inputUpdatedAt = formatArtifactUpdatedAt\(inputArtifact\?\.updated_at\)/)
  assert.match(source, /const outputUpdatedAt = formatArtifactUpdatedAt\(outArtifact\?\.updated_at\)/)
  assert.match(source, /taskDetail\.artifactModifiedAt/)
  assert.match(source, /t\('taskDetail\.artifactRound'/)
  assert.match(source, /t\('taskDetail\.outputDone'\)/)
})

test('keeps artifact dates and times on one line', () => {
  const inputUpdatedAtPos = source.indexOf('{inputUpdatedAt}')
  const outputUpdatedAtPos = source.indexOf('{outputUpdatedAt}')

  assert.match(source.slice(inputUpdatedAtPos - 500, inputUpdatedAtPos), /whiteSpace: 'nowrap'/)
  assert.match(source.slice(outputUpdatedAtPos - 500, outputUpdatedAtPos), /whiteSpace: 'nowrap'/)
})

test('reuses the mobile artifact panel from a desktop artifact tab', () => {
  assert.match(source, /useState<'detail' \| 'artifacts' \| 'analysis'>\('detail'\)/)
  assert.match(
    source,
    /!compact && \([\s\S]*setDetailMode\('artifacts'\)[\s\S]*t\('mobile\.artifacts'\)/,
  )
  assert.match(source, /detailMode === 'artifacts' && !compact[\s\S]*renderArtifactPanel\(\)/)
  assert.match(source, /compact && renderArtifactPanel\(\)/)
})
