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
const taskListSource = await readFile(
  new URL('../src/pages/TaskList.tsx', import.meta.url),
  'utf8',
)
const chatPageSource = await readFile(
  new URL('../src/pages/ChatPage.tsx', import.meta.url),
  'utf8',
)
const mobileCss = await readFile(new URL('../src/mobile.css', import.meta.url), 'utf8')
const indexCss = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

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

test('mobile workflow editor supports the same step editing panel as desktop', () => {
  assert.doesNotMatch(canvasEditorSource, /readOnly=\{compact\}/)
  assert.doesNotMatch(canvasEditorSource, /if \(!activeProject \|\| compact\) return/)
  assert.match(flowCanvasSource, /const readOnly = requestedReadOnly\b/)
  assert.match(flowCanvasSource, /onNodeClick=\{compactLayout && !readOnly/)
  assert.match(flowCanvasSource, /className="flow-node-config-panel"/)
  assert.match(mobileCss, /\.flow-node-config-panel\s*\{[^}]*position: absolute[^}]*width: 100% !important/s)
})

test('mobile workflow editing controls keep compact button heights', () => {
  assert.match(flowCanvasSource, /className="flow-canvas-toolbar"/)
  assert.match(mobileCss, /--mobile-toolbar-control-height:\s*var\(--mobile-control-regular\)/)
  assert.match(mobileCss, /\.flow-canvas-toolbar button[^{]*\{[^}]*height: var\(--mobile-toolbar-control-height\) !important[^}]*min-height: var\(--mobile-toolbar-control-height\) !important/s)
  assert.doesNotMatch(mobileCss, /\.flow-node-config-panel button\s*\{[^}]*min-height: 44px/s)
  assert.doesNotMatch(mobileCss, /\.flow-node-config-panel \.btn-icon\s*\{[^}]*min-width: 44px/s)
})

test('mobile task and workflow toolbars share one compact control size', () => {
  assert.match(taskListSource, /className="mobile-session-kebab mobile-toolbar-icon-button"/)
  assert.doesNotMatch(taskListSource, /mobile-task-menu-trigger/)
  assert.match(taskListSource, /<Icon name="ellipsis" size=\{20\}/)
  assert.doesNotMatch(mobileCss, /\.mobile-header button, \.navigation-close, \.mobile-task-toolbar > button/)
  assert.match(mobileCss, /\.mobile-task-toolbar > button\s*\{[^}]*height: var\(--mobile-toolbar-control-height\)[^}]*width: auto/s)
  assert.match(mobileCss, /\.mobile-toolbar-icon-button\s*\{[^}]*width: var\(--mobile-toolbar-control-height\)/s)
  assert.match(mobileCss, /\.flow-canvas-toolbar select\s*\{[^}]*min-width: 120px/s)
})

test('mobile task menu sits beside new task and includes Git', () => {
  assert.doesNotMatch(taskListSource, /createPortal\(/)
  assert.doesNotMatch(taskListSource, /document\.querySelector\('\.mobile-header-actions'\)/)
  const toolbar = taskListSource.slice(
    taskListSource.indexOf('className="mobile-task-toolbar"'),
    taskListSource.indexOf('</div>}', taskListSource.indexOf('className="mobile-task-toolbar"')),
  )
  assert.match(toolbar, /taskList\.new/)
  assert.match(toolbar, /className="mobile-session-kebab mobile-toolbar-icon-button"/)
  assert.ok(toolbar.indexOf("t('taskList.new')") < toolbar.indexOf('className="mobile-session-kebab mobile-toolbar-icon-button"'))
  assert.doesNotMatch(toolbar, /ProjectGitButton|sliders-horizontal|createPortal/)
  const sheet = taskListSource.slice(
    taskListSource.indexOf('<MobileSheet open={compact && filtersOpen}'),
    taskListSource.indexOf('</MobileSheet>', taskListSource.indexOf('<MobileSheet open={compact && filtersOpen}')),
  )
  assert.match(sheet, /className="mobile-task-menu"/)
  assert.match(sheet, /<ProjectGitButton project=\{activeProject\}/)
  assert.match(sheet, /taskList\.stepEdit/)
  assert.match(sheet, /schedules\.title/)
  assert.match(sheet, /taskList\.settings/)
  assert.ok(
    sheet.indexOf('<ProjectGitButton') < sheet.indexOf("t('taskList.settings')"),
    'Git should be immediately above project settings',
  )
  const afterGit = sheet.slice(sheet.indexOf('<ProjectGitButton') + '<ProjectGitButton project={activeProject} />'.length).trimStart()
  assert.ok(afterGit.startsWith('<Button onClick={() => { setFiltersOpen(false); setShowSettingsPanel(true) }}>'))
  assert.match(afterGit, /<Icon name="settings" size=\{16\}/)
  assert.match(mobileCss, /\.mobile-task-menu > button,[\s\S]*?\.mobile-task-menu > select\s*\{[^}]*height: var\(--mobile-button-height\) !important[^}]*font-size: var\(--mobile-control-font-size\) !important/s)
  assert.match(mobileCss, /\.mobile-task-menu > button svg\s*\{[^}]*width: var\(--mobile-control-icon-size\) !important[^}]*height: var\(--mobile-control-icon-size\) !important/s)
})

test('mobile chat menu hides open location and keeps Git above settings', () => {
  const sheetStart = chatPageSource.indexOf('<MobileSheet\n        open={mobileMenuOpen}')
  const sheet = chatPageSource.slice(sheetStart, chatPageSource.indexOf('</MobileSheet>', sheetStart))
  assert.ok(sheetStart >= 0)
  assert.doesNotMatch(sheet, /<OpenLocationButton/)
  assert.match(sheet, /<ProjectGitButton project=\{activeProject\}/)
  assert.ok(sheet.indexOf('<ProjectGitButton') < sheet.indexOf("t('taskList.settings')"))
})

test('mobile workflow toolbar items never shrink into each other', () => {
  assert.match(flowCanvasSource, /className="flow-canvas-toolbar-slot flow-canvas-toolbar-mid"/)
  assert.match(flowCanvasSource, /className="flow-canvas-toolbar-spacer"/)
  assert.match(mobileCss, /\.flow-canvas-toolbar > :not\(\.flow-canvas-toolbar-spacer\)\s*\{[^}]*flex:\s*0 0 auto/s)
  assert.match(mobileCss, /\.flow-canvas-toolbar-spacer\s*\{[^}]*flex:\s*1 0 0/s)
})

test('desktop workflow actions stay aligned to the right', () => {
  assert.match(indexCss, /\.flow-canvas-toolbar-spacer\s*\{[^}]*flex:\s*1 0 0/s)
})
