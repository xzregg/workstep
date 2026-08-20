import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const chatSource = await readFile(
  new URL('../src/components/AiFlowChat.tsx', import.meta.url),
  'utf8',
)
const editorPanelSource = await readFile(
  new URL('../src/components/AiFlowEditorPanel.tsx', import.meta.url),
  'utf8',
)
const assistantPanelSource = await readFile(
  new URL('../src/components/AssistantChatPanel.tsx', import.meta.url),
  'utf8',
)
const canvasEditorSource = await readFile(
  new URL('../src/pages/CanvasEditor.tsx', import.meta.url),
  'utf8',
)
const templateSettingsSource = await readFile(
  new URL('../src/pages/TemplateSettings.tsx', import.meta.url),
  'utf8',
)
const layoutSource = await readFile(
  new URL('../src/components/Layout.tsx', import.meta.url),
  'utf8',
)

test('AI flow chat repeatedly restores the initial canvas and bypasses proposal confirmation', () => {
  assert.match(chatSource, /onRestore\?: \(steps: any\) => void/)
  assert.match(chatSource, /getCanvasStepsRef\.current = getCanvasSteps/)
  assert.match(chatSource, /setRestoreSteps\(cloneCanvasSteps\(initialSteps\)\)/)
  assert.match(chatSource, /onRestore\?\.\(cloneCanvasSteps\(restoreSteps\)\)/)
  assert.doesNotMatch(chatSource, /setRestoreSteps\([^)]*\)[\s\S]{0,120}onProposal\?\.\(steps\)/)
  assert.doesNotMatch(chatSource, /restored|setRestored/)
  assert.match(chatSource, /disabled=\{running \|\| restoreSteps === null\}/)
  assert.match(chatSource, /composerActions=\{<Button/)
  assert.doesNotMatch(chatSource, /headerActions=\{<>\s*<Button[\s\S]*restoreStepsHint/)
  assert.match(assistantPanelSource, /composerActions\?: ReactNode/)
  assert.match(assistantPanelSource, /\{composerActions\}/)
  assert.match(editorPanelSource, /onRestore=\{onRestore\}/)
  assert.match(canvasEditorSource, /onRestore=\{\(steps\) => canvasRef\.current\?\.loadSteps\(steps\)\}/)
  assert.match(templateSettingsSource, /onRestore=\{\(steps\) => canvasRef\.current\?\.loadSteps\(steps\)\}/)
  assert.match(layoutSource, /onRestore=\{\(steps\) => previewCanvasRef\.current\?\.loadSteps\(steps\)\}/)
})
