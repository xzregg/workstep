import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const checklistSource = await readFile(new URL('../src/components/OnboardingChecklist.tsx', import.meta.url), 'utf8')
const layoutSource = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')
const actionsSource = await readFile(new URL('../src/components/LayoutOnboardingActions.tsx', import.meta.url), 'utf8')
const settingsSource = await readFile(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8')
const mobileCss = await readFile(new URL('../src/mobile.css', import.meta.url), 'utf8')
const taskListSource = await readFile(new URL('../src/pages/TaskList.tsx', import.meta.url), 'utf8')
const taskCreateSource = await readFile(new URL('../src/components/TaskCreatePanel.tsx', import.meta.url), 'utf8')
const canvasSource = await readFile(new URL('../src/pages/CanvasEditor.tsx', import.meta.url), 'utf8')
const onboardingSource = await readFile(new URL('../src/utils/onboarding.ts', import.meta.url), 'utf8')

test('checklist completes steps from action clicks without remote readiness checks', () => {
  assert.match(checklistSource, /state\.completeStep\(step\)/)
  assert.match(checklistSource, /state\.completedSteps\.includes\(step\)/)
  assert.doesNotMatch(checklistSource, /providerApi\.list\(\)/)
  assert.doesNotMatch(checklistSource, /engineApi\.executionConfig\(\)/)
  assert.doesNotMatch(checklistSource, /taskApi\.get\(/)
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
  assert.match(layoutSource, /<LayoutOnboardingActions/)
  assert.match(actionsSource, /openSettings\('providers', 'provider-create'\)/)
  assert.match(actionsSource, /chooseSetupMode\('local'\)/)
  assert.match(actionsSource, /buildStarterWorkflow\(engineId, model\)/)
  assert.match(actionsSource, /onboarding=create-task/)
  assert.match(taskListSource, /<TaskCreatePanel/)
  assert.match(taskCreateSource, /onboarding\.recordTask\(task\.id\)/)
})

test('onboarding offers provider and local Agent paths', () => {
  assert.match(checklistSource, /onboarding\.steps\.provider\.localAction/)
})

test('the starter canvas explanation is contextual and dismissible', () => {
  assert.match(canvasSource, /searchParams\.get\('onboarding'\) === '1'/)
  assert.match(canvasSource, /markCanvasHintSeen/)
  assert.match(canvasSource, /onboarding\.canvasHintBody/)
})

test('completed onboarding disappears from the workspace and remains available in settings', () => {
  assert.match(checklistSource, /state\.status === 'dismissed' \|\| state\.status === 'completed'/)
  assert.match(checklistSource, /onboarding\.skipAll/)
  assert.match(checklistSource, /onClick=\{state\.skip\}/)
  assert.doesNotMatch(layoutSource, /className="onboarding-reopen-button"/)
  assert.match(settingsSource, /useOnboardingStore\.getState\(\)\.reopen\(\)/)
  assert.match(settingsSource, /t\('settings\.onboardingTitle'\)/)
})

test('mobile navigation hides the floating onboarding controls', () => {
  assert.match(
    mobileCss,
    /\.responsive-navigation \.onboarding-checklist,\s*\.responsive-navigation \.onboarding-launcher\s*\{[^}]*display:\s*none\s*!important/s,
  )
})
