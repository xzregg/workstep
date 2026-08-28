import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const checklistSource = await readFile(new URL('../src/components/OnboardingChecklist.tsx', import.meta.url), 'utf8')
const layoutSource = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')
const taskListSource = await readFile(new URL('../src/pages/TaskList.tsx', import.meta.url), 'utf8')
const canvasSource = await readFile(new URL('../src/pages/CanvasEditor.tsx', import.meta.url), 'utf8')

test('checklist derives completed steps from real resources without manual checkboxes', () => {
  assert.match(checklistSource, /providerApi\.list\(\)/)
  assert.match(checklistSource, /engineApi\.executionConfig\(\)/)
  assert.match(checklistSource, /taskApi\.get\(current\.taskId, project\.id\)/)
  assert.doesNotMatch(checklistSource, /type=["']checkbox["']/)
})

test('each onboarding step exposes its navigation path', () => {
  assert.match(checklistSource, /path: 'onboarding\.steps\.provider\.path'/)
  assert.match(checklistSource, /path: 'onboarding\.steps\.engine\.path'/)
  assert.match(checklistSource, /path: 'onboarding\.steps\.project\.path'/)
  assert.match(checklistSource, /path: 'onboarding\.steps\.workflow\.path'/)
  assert.match(checklistSource, /path: 'onboarding\.steps\.task\.path'/)
  assert.match(checklistSource, /onboarding-step-path/)
  assert.match(checklistSource, /t\(COPY\[step\]\.path\)/)
})

test('onboarding actions reuse the real settings, project, workflow, and task paths', () => {
  assert.match(layoutSource, /openOnboardingSettings\('providers', 'provider-create'\)/)
  assert.match(layoutSource, /buildStarterWorkflow\(onboarding\.engineId, model\)/)
  assert.match(layoutSource, /onboarding=create-task/)
  assert.match(taskListSource, /onboarding\.recordTask\(task\.id\)/)
})

test('the starter canvas explanation is contextual and dismissible', () => {
  assert.match(canvasSource, /searchParams\.get\('onboarding'\) === '1'/)
  assert.match(canvasSource, /markCanvasHintSeen/)
  assert.match(canvasSource, /onboarding\.canvasHintBody/)
})
