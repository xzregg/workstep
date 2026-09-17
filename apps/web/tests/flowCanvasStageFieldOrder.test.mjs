import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const flowCanvasSource = await readFile(
  new URL('../src/components/FlowCanvas.tsx', import.meta.url),
  'utf8',
)

test('stage editor places input artifacts and stage review between prompt and engine selection', () => {
  const promptIndex = flowCanvasSource.indexOf("t('flow.prompt')")
  const inputEditorIndex = flowCanvasSource.indexOf('<InputEditor')
  const reviewIndex = flowCanvasSource.indexOf("t('flow.stageReview')")
  const engineIndex = flowCanvasSource.indexOf("t('flow.engine')")

  assert.ok(promptIndex >= 0)
  assert.ok(inputEditorIndex >= 0)
  assert.ok(reviewIndex >= 0)
  assert.ok(engineIndex >= 0)
  assert.ok(promptIndex < inputEditorIndex)
  assert.ok(inputEditorIndex < reviewIndex)
  assert.ok(reviewIndex < engineIndex)
})
