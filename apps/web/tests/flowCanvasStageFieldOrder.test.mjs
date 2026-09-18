import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const flowCanvasSource = await readFile(
  new URL('../src/components/FlowCanvas.tsx', import.meta.url),
  'utf8',
)

test('stage editor places engine selection and config before stage review', () => {
  const promptIndex = flowCanvasSource.indexOf("t('flow.prompt')")
  const inputEditorIndex = flowCanvasSource.indexOf('<InputEditor')
  const engineIndex = flowCanvasSource.indexOf("t('flow.engine')")
  const stageConfigIndex = flowCanvasSource.indexOf("t('flow.stageConfig')")
  const reviewIndex = flowCanvasSource.indexOf("t('flow.stageReview')")

  assert.ok(promptIndex >= 0)
  assert.ok(inputEditorIndex >= 0)
  assert.ok(engineIndex >= 0)
  assert.ok(stageConfigIndex >= 0)
  assert.ok(reviewIndex >= 0)
  assert.ok(promptIndex < inputEditorIndex)
  assert.ok(inputEditorIndex < engineIndex)
  assert.ok(engineIndex < stageConfigIndex)
  assert.ok(stageConfigIndex < reviewIndex)
})
