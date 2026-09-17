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
  assert.match(sharedViewSource, /readOnly=\{!interactive\}/)
  assert.match(sharedViewSource, /interactionOnly=\{interactive\}/)
  assert.match(sharedViewSource, /onReviewAction=\{interactive \?/)
})


test('interactive share selects an actionable stage and mounts live interaction events', () => {
  assert.match(sharedViewSource, /resumableStages/)
  assert.match(sharedViewSource, /runningStages\[0\]\?\.key \?\? resumableStages\[0\]\?\.key/)
  assert.match(sharedViewSource, /workstep\.interaction_request/)
  assert.match(sharedViewSource, /workstep\.interaction_response/)
  assert.match(sharedViewSource, /shouldRefreshReviews/)
  assert.match(sharedViewSource, /handleA2uiAction/)
  assert.match(sharedViewSource, /onA2uiAction=\{interactive \? handleA2uiAction/)
})
