import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const componentSource = await readFile(
  new URL('../src/components/ShareDialog.tsx', import.meta.url),
  'utf8',
)
const shareSource = await readFile(
  new URL('../src/api/share.ts', import.meta.url),
  'utf8',
)
const taskApiSource = await readFile(
  new URL('../src/api/task.ts', import.meta.url),
  'utf8',
)
const sharedViewSource = await readFile(
  new URL('../src/pages/SharedTaskView.tsx', import.meta.url),
  'utf8',
)
const sharedMessagesSource = await readFile(
  new URL('../src/pages/sharedTaskMessages.ts', import.meta.url),
  'utf8',
)
const taskDetailViewSource = await readFile(
  new URL('../src/components/TaskDetailView.tsx', import.meta.url),
  'utf8',
)

test('task sharing creates either a read-only or interactive link', () => {
  assert.match(componentSource, /type ShareMode = 'read_only' \| 'interactive'/)
  assert.match(componentSource, /useState<ShareMode>\('read_only'\)/)
  assert.match(componentSource, /modeReadOnly/)
  assert.match(componentSource, /modeInteractive/)
  assert.match(componentSource, /mode,/)
})

test('share can be opened in a standalone window', () => {
  assert.match(componentSource, /window\.open\(\s*shareUrl,/)
  assert.match(componentSource, /share\.openWindow/)
})

test('public share client exposes mode and interactive actions', () => {
  assert.match(taskApiSource, /mode: 'read_only' \| 'interactive' = 'read_only'/)
  assert.match(shareSource, /sendStepMessage:/)
  assert.match(shareSource, /resumeStep:/)
  assert.match(shareSource, /cancelStep:/)
  assert.match(shareSource, /decideReview:/)
  assert.match(shareSource, /respondInteraction:/)
})

test('shared task view enables interactions only for interactive shares', () => {
  assert.match(sharedViewSource, /meta\?\.mode === 'interactive'/)
  assert.match(sharedViewSource, /chatEnabled=\{interactive\}/)
  assert.doesNotMatch(sharedViewSource, /interactionOnly=/)
  assert.doesNotMatch(sharedViewSource, /onReviewAction=\{interactive \?/)
  assert.match(sharedViewSource, /uploadAttachment/)
  assert.match(sharedViewSource, /markdownUrlResolver/)
  assert.match(sharedViewSource, /shareApi\.executionReport/)
  assert.match(sharedViewSource, /loadExecutionReport: executionReportLoader/)
  assert.match(sharedViewSource, /readCapabilities=\{\{/)
})

test('share mode controls the chat composer and Git write access without hiding task content', () => {
  assert.match(sharedViewSource, /chatEnabled=\{interactive\}/)
  assert.match(sharedViewSource, /gitCapability=\{\{[^}]*readOnly: !interactive/)
  assert.doesNotMatch(taskDetailViewSource, /\breadOnly\b/)
  assert.doesNotMatch(sharedViewSource, /runningSteps=\{interactive \?/)
  assert.doesNotMatch(sharedViewSource, /sharePrimaryAction/)
})


test('interactive share selects an actionable step for its composer', () => {
  assert.match(sharedViewSource, /resumableSteps/)
  assert.match(sharedViewSource, /runningSteps\[0\]\?\.key \?\? resumableSteps\[0\]\?\.key/)
  assert.match(sharedMessagesSource, /workstep\.interaction_request/)
  assert.match(sharedMessagesSource, /workstep\.interaction_response/)
})
