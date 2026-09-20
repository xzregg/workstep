import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const canvasEditorSource = await readFile(
  new URL('../src/pages/CanvasEditor.tsx', import.meta.url),
  'utf8',
)
const panelSource = await readFile(
  new URL('../src/components/AiFlowEditorPanel.tsx', import.meta.url),
  'utf8',
)
const flowCanvasSource = await readFile(
  new URL('../src/components/FlowCanvas.tsx', import.meta.url),
  'utf8',
)
const mobileCss = await readFile(new URL('../src/mobile.css', import.meta.url), 'utf8')

test('mobile workflow editor exposes the flow assistant as a full-screen panel', () => {
  assert.doesNotMatch(canvasEditorSource, /disabled=\{!activeProject\?\.id \|\| compact\}/)
  assert.doesNotMatch(canvasEditorSource, /display: compact \? 'none' : 'contents'/)
  assert.match(canvasEditorSource, /className="ai-flow-editor-host"/)
  assert.match(panelSource, /className="ai-flow-editor-mobile-header"/)
  assert.match(panelSource, /className="ai-flow-editor-panel"/)
  assert.match(mobileCss, /\.ai-flow-editor-host\s*\{[^}]*position: absolute/s)
  assert.match(mobileCss, /\.ai-flow-editor-panel\s*\{[^}]*width: 100%/s)
})

test('assistant can programmatically apply and persist a workflow on mobile', () => {
  const loadStepsBody = flowCanvasSource.slice(
    flowCanvasSource.indexOf('loadSteps: (steps: any) => {'),
    flowCanvasSource.indexOf('},\n  }),', flowCanvasSource.indexOf('loadSteps: (steps: any) => {')),
  )
  assert.doesNotMatch(loadStepsBody, /if \(readOnly\) return/)
  assert.match(canvasEditorSource, /if \(compact\) \{/)
  assert.match(canvasEditorSource, /await saveSteps\(activeProject\.id, steps\)/)
})
