import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const componentSource = await readFile(
  new URL('../src/components/ShareDialog.tsx', import.meta.url),
  'utf8',
)
const clientSource = await readFile(
  new URL('../src/api/client.ts', import.meta.url),
  'utf8',
)
const sharedViewSource = await readFile(
  new URL('../src/pages/SharedTaskView.tsx', import.meta.url),
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
  assert.match(clientSource, /mode: 'read_only' \| 'interactive' = 'read_only'/)
  assert.match(clientSource, /sendStageMessage:/)
  assert.match(clientSource, /resumeStage:/)
  assert.match(clientSource, /cancelStage:/)
  assert.match(clientSource, /decideReview:/)
  assert.match(clientSource, /respondInteraction:/)
})

test('shared task view enables interactions only for interactive shares', () => {
  assert.match(sharedViewSource, /meta\?\.mode === 'interactive'/)
  assert.match(sharedViewSource, /readOnly/)
  assert.match(sharedViewSource, /chatEnabled=\{interactive\}/)
  assert.doesNotMatch(sharedViewSource, /interactionOnly=/)
  assert.doesNotMatch(sharedViewSource, /onReviewAction=\{interactive \?/)
  assert.match(sharedViewSource, /uploadAttachment/)
  assert.match(sharedViewSource, /markdownUrlResolver/)
})

test('read-only and interactive shares differ only by the chat composer capability', () => {
  assert.match(sharedViewSource, /readOnly\s*\n/)
  assert.match(sharedViewSource, /chatEnabled=\{interactive\}/)
  assert.doesNotMatch(sharedViewSource, /runningStages=\{interactive \?/)
  assert.doesNotMatch(sharedViewSource, /sharePrimaryAction/)
})


test('interactive share selects an actionable stage for its composer', () => {
  assert.match(sharedViewSource, /resumableStages/)
  assert.match(sharedViewSource, /runningStages\[0\]\?\.key \?\? resumableStages\[0\]\?\.key/)
  assert.match(sharedViewSource, /workstep\.interaction_request/)
  assert.match(sharedViewSource, /workstep\.interaction_response/)
  assert.match(sharedViewSource, /shouldRefreshReviews/)
})
