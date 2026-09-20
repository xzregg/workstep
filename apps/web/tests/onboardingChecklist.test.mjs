import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const checklistSource = await readFile(new URL('../src/components/OnboardingChecklist.tsx', import.meta.url), 'utf8')
const layoutSource = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')
const settingsSource = await readFile(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8')
const mobileCss = await readFile(new URL('../src/mobile.css', import.meta.url), 'utf8')
const taskListSource = await readFile(new URL('../src/pages/TaskList.tsx', import.meta.url), 'utf8')
const canvasSource = await readFile(new URL('../src/pages/CanvasEditor.tsx', import.meta.url), 'utf8')
const onboardingSource = await readFile(new URL('../src/utils/onboarding.ts', import.meta.url), 'utf8')

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
  assert.match(layoutSource, /chooseSetupMode\('local'\)/)
  assert.match(layoutSource, /buildStarterWorkflow\(onboarding\.engineId, model\)/)
  assert.match(layoutSource, /onboarding=create-task/)
  assert.match(taskListSource, /onboarding\.recordTask\(task\.id\)/)
})

test('onboarding offers provider and local Agent paths and requires an engine test', () => {
  assert.match(checklistSource, /onboarding\.steps\.provider\.localAction/)
  assert.match(checklistSource, /isEngineReady\(item, execution\)/)
  assert.match(onboardingSource, /&& engine\.verified/)
})

test('the starter canvas explanation is contextual and dismissible', () => {
  assert.match(canvasSource, /searchParams\.get\('onboarding'\) === '1'/)
  assert.match(canvasSource, /markCanvasHintSeen/)
  assert.match(canvasSource, /onboarding\.canvasHintBody/)
})

test('completed onboarding disappears from the workspace and remains available in settings', () => {
  assert.match(checklistSource, /state\.status === 'dismissed' \|\| state\.status === 'completed'/)
  assert.match(layoutSource, /onboardingStatus !== 'completed'/)
  assert.match(settingsSource, /useOnboardingStore\.getState\(\)\.reopen\(\)/)
  assert.match(settingsSource, /t\('settings\.onboardingTitle'\)/)
})

test('mobile navigation hides every onboarding entry point', () => {
  assert.match(layoutSource, /className="onboarding-reopen-button"/)
  assert.match(
    mobileCss,
    /\.responsive-navigation \.onboarding-checklist,\s*\.responsive-navigation \.onboarding-launcher,\s*\.responsive-navigation \.onboarding-reopen-button\s*\{[^}]*display:\s*none\s*!important/s,
  )
})
