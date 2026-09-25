import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/TaskDetailView.tsx', import.meta.url), 'utf8')
const headerSource = await readFile(new URL('../src/components/TaskDetailHeader.tsx', import.meta.url), 'utf8')
const descriptionSource = await readFile(new URL('../src/components/TaskDetailDescription.tsx', import.meta.url), 'utf8')
const tabsSource = await readFile(new URL('../src/components/TaskDetailTabs.tsx', import.meta.url), 'utf8')
const ioSource = await readFile(new URL('../src/components/TaskStepIoPanel.tsx', import.meta.url), 'utf8')
const pageSource = await readFile(new URL('../src/pages/TaskDetail.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

test('lets users select the task title while keeping the header draggable', () => {
  assert.match(headerSource, /className="task-detail-title"/)
  assert.match(pageSource, /closest\([^)]*\.task-detail-title/)
  assert.match(css, /\.task-detail-header\s*\{[^}]*user-select:\s*none/s)
  assert.match(css, /\.task-detail-title\s*\{[^}]*user-select:\s*text/s)
})

test('task detail assembles the description module and enables editing only in owner view', () => {
  assert.match(source, /<TaskDetailDescription key=\{task\.id\} task=\{task\} projectId=\{projectId\} editable=\{descriptionEditable\}/)
  assert.match(pageSource, /descriptionEditable/)
  assert.match(descriptionSource, /scheduled_start_at/)
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
  const ioPos = source.indexOf('<TaskStepIoPanel')
  const promptPos = source.indexOf('<TaskStepPrompt')

  assert.ok(ioPos >= 0, 'step input and output section missing')
  assert.ok(promptPos > ioPos, 'step input and output should precede the step prompt')
})

test('offers rerunning a completed step with the latest workflow contract', () => {
  const ioPos = ioSource.indexOf("{t('taskDetail.stepIo')}")
  const rerunPos = ioSource.indexOf("t('taskDetail.rerunLatestWorkflow')", ioPos)

  assert.ok(rerunPos > ioPos, 'latest-workflow rerun action missing from step IO')
  assert.match(ioSource, /onRestartStepWithFreshSession\?\.\(currentStep\.key\)/)
  assert.match(ioSource, /hasStepIoContractChanged\(currentStep, progress\?\.io_contract\)/)
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
  const outputReadyPos = ioSource.indexOf('const outputReady = Boolean(outputArtifact)')
  const namePos = ioSource.indexOf('{output.name}', outputReadyPos)
  const typePos = ioSource.indexOf('{output.type}', namePos)
  const statusPos = ioSource.indexOf("t('taskDetail.outputDone')", outputReadyPos)

  assert.ok(outputReadyPos >= 0, 'output readiness guard missing')
  assert.ok(namePos > outputReadyPos, 'output name missing')
  assert.ok(typePos > namePos, 'output file type should follow the output name')
  assert.ok(statusPos > outputReadyPos, 'output status badge missing')
  assert.ok(statusPos > typePos, 'output status badge should follow the file type')
  assert.match(ioSource, /outputReady && <span className="task-step-io-open">\{t\('common\.open'\)\}/)
  assert.match(ioSource, /role=\{outputReady \? 'button' : undefined\}/)
  assert.match(css, /\.task-step-io-output\[data-openable="true"\][^{]*\{ cursor: pointer/)
})

test('shows artifact round status and modified time in step IO rows', () => {
  assert.match(ioSource, /const dateText =/)
  assert.match(ioSource, /\.sort\(\(a, b\) => a - b\)/)
  assert.match(ioSource, /rounds\[rounds\.length - 1\]/)
  assert.match(tabsSource, /role="tablist"/)
  assert.match(ioSource, /onSelect=\{setSelectedRound\}/)
  assert.match(ioSource, /findStepRoundInputArtifact\(/)
  assert.match(ioSource, /findStepRoundInputPort\(/)
  assert.match(ioSource, /artifactsForStepRoundOutputs\(/)
  assert.match(ioSource, /groupStepOutputsByInput\(/)
  assert.match(ioSource, /downstreamInputsForOutput\(/)
  assert.match(ioSource, /artifactInputSnapshots, currentStep\.key, executionRound, inputIndex/)
  assert.match(ioSource, /snapshot \? undefined : findPreferredArtifact\(artifacts, input\.name\)/)
  assert.match(ioSource, /role=\{inputArtifact \? 'button' : undefined\}/)
  assert.match(ioSource, /const inputUpdatedAt = dateText\(inputArtifact\?\.updated_at\)/)
  assert.match(ioSource, /const outputUpdatedAt = dateText\(outputArtifact\?\.updated_at\)/)
  for (const key of ['artifactModifiedAt', 'artifactRound', 'outputDone', 'inputReady',
    'inputUnavailable', 'inputTaskContext', 'inputInactive']) {
    assert.match(ioSource, new RegExp(`taskDetail\\.${key}`))
  }
})

test('keeps artifact dates and times on one line', () => {
  assert.match(ioSource, /className="task-step-io-date"/)
  assert.match(css, /\.task-step-io-date\s*\{[^}]*white-space: nowrap/s)
})

test('reuses the mobile artifact panel from a desktop artifact tab', () => {
  assert.match(source, /useState<'detail' \| 'artifacts' \| 'analysis' \| 'git'>\('detail'\)/)
  assert.match(source, /!compact \? \[\{ id: 'artifacts', label: t\('mobile\.artifacts'\) \}\]/)
  assert.match(source, /detailMode === 'artifacts' && !compact[\s\S]*renderArtifactPanel\(\)/)
  assert.match(source, /compact && renderArtifactPanel\(\)/)
})
