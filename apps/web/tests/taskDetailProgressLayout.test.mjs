import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/TaskDetailView.tsx', import.meta.url), 'utf8')
const headerSource = await readFile(new URL('../src/components/TaskDetailHeader.tsx', import.meta.url), 'utf8')
const descriptionSource = await readFile(new URL('../src/components/TaskDetailDescription.tsx', import.meta.url), 'utf8')
const tabsSource = await readFile(new URL('../src/components/TaskDetailTabs.tsx', import.meta.url), 'utf8')
const pageSource = await readFile(new URL('../src/pages/TaskDetail.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

test('lets users select the task title while keeping the header draggable', () => {
  assert.match(headerSource, /className="task-detail-title"/)
  assert.match(pageSource, /closest\([^)]*\.task-detail-title/)
  assert.match(css, /\.task-detail-header\s*\{[^}]*user-select:\s*none/s)
  assert.match(css, /\.task-detail-title\s*\{[^}]*user-select:\s*text/s)
})

test('places the scheduled start input beside the description save actions', () => {
  const actionInputPos = descriptionSource.indexOf('{leadingActions}')
  const cancelPos = descriptionSource.indexOf("{t('common.cancel')}", actionInputPos)

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
  const descriptionPos = descriptionSource.indexOf("{t('taskDetail.description')}")
  const scheduledTimePos = descriptionSource.indexOf('{scheduledStartText}', descriptionPos)
  const editPos = descriptionSource.indexOf("aria-label={t('taskDetail.editDescriptionAria')}", descriptionPos)

  assert.ok(scheduledTimePos > descriptionPos, 'scheduled execution time missing beside description')
  assert.ok(editPos > scheduledTimePos, 'edit action should follow the scheduled execution time')
  assert.match(pageSource, /scheduledStartText=\{formatScheduledStart\(task\.scheduled_start_at\)\}/)
})

test('uses the dedicated step progress graph component', () => {
  assert.match(source, /import TaskStepProgressGraph from '\.\/TaskStepProgressGraph'/)
  assert.match(source, /<TaskStepProgressGraph[\s\S]*steps=\{steps\}[\s\S]*stepProgress=\{stepProgress\}/)
  assert.doesNotMatch(source, /\/\* Progress timeline \*\//)
})

test('opens the task created by a workflow dispatch step', () => {
  assert.match(pageSource, /kind: node\.kind === 'task_dispatch'/)
  assert.match(pageSource, /taskApi\.list\(targetProjectId, targetWorkflowId\)/)
  assert.match(pageSource, /findLatestDispatchedTask\([\s\S]*taskId,[\s\S]*clickedStep\.key/)
  assert.match(pageSource, /openTask\(dispatchedTask\.id, targetProject\?\.name, targetWorkflowId\)/)
})

test('places step input and output before the step prompt', () => {
  const ioPos = source.indexOf("{t('taskDetail.stepIo')}")
  const promptPos = source.indexOf("{t('taskDetail.stepPrompt')}")

  assert.ok(ioPos >= 0, 'step input and output section missing')
  assert.ok(promptPos > ioPos, 'step input and output should precede the step prompt')
})

test('offers rerunning a completed step with the latest workflow contract', () => {
  const ioPos = source.indexOf("{t('taskDetail.stepIo')}")
  const rerunPos = source.indexOf("t('taskDetail.rerunLatestWorkflow')", ioPos)

  assert.ok(rerunPos > ioPos, 'latest-workflow rerun action missing from step IO')
  assert.match(source, /onRestartStepWithFreshSession\?\.\(currentStep\.key\)/)
  assert.match(source, /hasStepIoContractChanged\(currentStep, currentStepProgress\?\.io_contract\)/)
})

test('opens directory artifacts in the artifact preview browser', () => {
  const openArtifactPos = pageSource.indexOf('const openArtifact =')
  const previewPos = pageSource.indexOf('setPreviewArtifact(artifact)', openArtifactPos)

  assert.ok(previewPos > openArtifactPos, 'artifact preview state is not set')
  assert.doesNotMatch(
    pageSource.slice(openArtifactPos, previewPos),
    /fsApi\.openDirectory\(artifact\.path\)/,
  )
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

test('shows artifact round status and modified time in step IO rows', () => {
  assert.match(source, /const formatArtifactUpdatedAt = useCallback/)
  assert.match(source, /return \[\.\.\.rounds\]\.sort\(\(a, b\) => a - b\)/)
  assert.match(source, /currentStepArtifactRounds\[currentStepArtifactRounds\.length - 1\]/)
  assert.match(tabsSource, /role="tablist"/)
  assert.match(source, /onSelect=\{setSelectedIoRound\}/)
  assert.match(source, /const snapshotInputArtifact = findStepRoundInputArtifact\(/)
  assert.match(source, /const inputPortSnapshot = findStepRoundInputPort\(/)
  assert.match(source, /const producedOutputs = artifactsForStepRoundOutputs\(/)
  assert.match(source, /groupStepOutputsByInput\(/)
  assert.match(source, /downstreamInputsForOutput\(/)
  assert.match(source, /artifactInputSnapshots,[\s\S]*selectedExecutionRound,[\s\S]*inpIdx/)
  assert.match(source, /inputPortSnapshot \? undefined : findArtifact\(inp\.name\)/)
  assert.match(source, /role=\{inputArtifact \? 'button' : undefined\}/)
  assert.match(source, /const inputUpdatedAt = formatArtifactUpdatedAt\(inputArtifact\?\.updated_at\)/)
  assert.match(source, /const outputUpdatedAt = formatArtifactUpdatedAt\(outArtifact\?\.updated_at\)/)
  assert.match(source, /taskDetail\.artifactModifiedAt/)
  assert.match(source, /t\('taskDetail\.artifactRound'/)
  assert.match(source, /t\('taskDetail\.outputDone'\)/)
  assert.match(source, /t\('taskDetail\.inputReady'\)/)
  assert.match(source, /t\('taskDetail\.inputUnavailable'\)/)
  assert.match(source, /t\('taskDetail\.inputTaskContext'\)/)
  assert.match(source, /t\('taskDetail\.inputInactive'\)/)
})

test('keeps artifact dates and times on one line', () => {
  const inputUpdatedAtPos = source.indexOf('{inputUpdatedAt}')
  const outputUpdatedAtPos = source.indexOf('{outputUpdatedAt}')

  assert.match(source.slice(inputUpdatedAtPos - 500, inputUpdatedAtPos), /whiteSpace: 'nowrap'/)
  assert.match(source.slice(outputUpdatedAtPos - 500, outputUpdatedAtPos), /whiteSpace: 'nowrap'/)
})

test('reuses the mobile artifact panel from a desktop artifact tab', () => {
  assert.match(source, /useState<'detail' \| 'artifacts' \| 'analysis' \| 'git'>\('detail'\)/)
  assert.match(source, /!compact \? \[\{ id: 'artifacts', label: t\('mobile\.artifacts'\) \}\]/)
  assert.match(source, /detailMode === 'artifacts' && !compact[\s\S]*renderArtifactPanel\(\)/)
  assert.match(source, /compact && renderArtifactPanel\(\)/)
})
