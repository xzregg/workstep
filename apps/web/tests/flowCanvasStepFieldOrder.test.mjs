import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const flowCanvasSource = await readFile(
  new URL('../src/components/NodeConfigPanel.tsx', import.meta.url),
  'utf8',
)

test('step editor places engine selection and config before step review', () => {
  const promptIndex = flowCanvasSource.indexOf("t('flow.prompt')")
  const inputEditorIndex = flowCanvasSource.indexOf('<InputEditor')
  const engineIndex = flowCanvasSource.indexOf("t('flow.engine')")
  const stepConfigIndex = flowCanvasSource.indexOf("t('flow.stepConfig')")
  const reviewIndex = flowCanvasSource.indexOf("t('flow.stepReview')")

  assert.ok(promptIndex >= 0)
  assert.ok(inputEditorIndex >= 0)
  assert.ok(engineIndex >= 0)
  assert.ok(stepConfigIndex >= 0)
  assert.ok(reviewIndex >= 0)
  assert.ok(promptIndex < inputEditorIndex)
  assert.ok(inputEditorIndex < engineIndex)
  assert.ok(engineIndex < stepConfigIndex)
  assert.ok(stepConfigIndex < reviewIndex)
})
