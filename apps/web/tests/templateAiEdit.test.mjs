import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(
  new URL('../src/pages/TemplateSettings.tsx', import.meta.url),
  'utf8',
)
const panelSource = await readFile(
  new URL('../src/components/AiFlowEditorPanel.tsx', import.meta.url),
  'utf8',
).catch(() => '')
const canvasEditorSource = await readFile(
  new URL('../src/pages/CanvasEditor.tsx', import.meta.url),
  'utf8',
)

test('template editor reuses the shared AI flow editor with isolated template context', () => {
  assert.match(source, /import AiFlowEditorPanel from '..\/components\/AiFlowEditorPanel'/)
  assert.match(panelSource, /import AiFlowChat from '.\/AiFlowChat'/)
  assert.match(source, /useProjectStore\(\(state\) => state\.activeProject\)/)
  assert.match(source, /ref=\{canvasRef\}/)
  assert.match(source, /<AiFlowEditorPanel/)
  assert.match(source, /projectId=\{activeProject\?\.id \|\| ''\}/)
  assert.match(source, /workflowId=\{`template:\$\{editing\.id\}`\}/)
  assert.match(source, /getCanvasSteps=\{\(\) => canvasRef\.current\?\.getSteps\(\)\}/)
  assert.match(source, /canvasRef\.current\?\.loadSteps\(steps\)/)
})

test('template AI editor guards manual changes and running generation on close', () => {
  assert.match(source, /if \(canvasDirty\) \{ setPendingAiSteps\(steps\); return \}/)
  assert.match(source, /open=\{pendingAiSteps !== null\}/)
  assert.match(source, /if \(aiGenBusy\) \{ setAiConfirmClose\(true\); return \}/)
  assert.match(source, /open=\{aiConfirmClose\}/)
})

test('flow assistant toolbar button toggles its open panel', () => {
  for (const editorSource of [canvasEditorSource, source]) {
    assert.match(editorSource, /aria-expanded=\{aiPanelOpen\}/)
    assert.match(editorSource, /if \(aiPanelOpen\) \{\s*requestCloseAiPanel\(\)\s*return\s*\}/)
    assert.match(editorSource, /onClick=\{toggleAiPanel\}/)
  }
})
