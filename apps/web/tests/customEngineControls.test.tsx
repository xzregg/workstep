import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { engineApi } from '../src/api/client'
import CustomEngineControls from '../src/components/CustomEngineControls'
import CustomEngineOnboardingButton from '../src/components/CustomEngineOnboardingButton'
import { loadDraft } from '../src/utils/chatDraft'
function Location() { return <output>{useLocation().search}</output> }
test('custom onboarding creates ordinary chat and prefills draft before closing settings', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = engineApi.customOnboarding
  useLocaleStore.getState().setLocale('en-US')
  let closed = 0
  engineApi.customOnboarding = async () => ({ project_id: 'draft-project', project_name: 'draft', session_id: 'draft-session', workspace_path: '/runtime/draft', prompt: '$custom-engine test' })
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><CustomEngineOnboardingButton onStarted={() => { closed += 1 }} /><Location /></I18nProvider></MemoryRouter>))
    await act(async () => { (document.querySelector('button') as HTMLButtonElement).click() })
    assert.match(loadDraft('draft-session')!, /Help me integrate/)
    assert.match(loadDraft('draft-session')!, /\/runtime\/draft/)
    assert.match(loadDraft('draft-session')!, /references\/custom-engine.md/)
    assert.doesNotMatch(loadDraft('draft-session')!, /\$custom-engine/)
    assert.match(document.querySelector('output')!.textContent!, /session=draft-session/)
    assert.equal(closed, 1)
  } finally { engineApi.customOnboarding = original; await act(async () => root.unmount()); await window.happyDOM.close() }
})
test('onboarding failure stays in settings and displays an error', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = engineApi.customOnboarding
  engineApi.customOnboarding = async () => { throw new Error('先配置引擎') }
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><CustomEngineOnboardingButton /></I18nProvider></MemoryRouter>))
    await act(async () => { (document.querySelector('button') as HTMLButtonElement).click() })
    assert.equal(document.querySelector('[role=alert]')!.textContent, '先配置引擎')
    assert.equal((document.querySelector('button') as HTMLButtonElement).disabled, false)
  } finally { engineApi.customOnboarding = original; await act(async () => root.unmount()); await window.happyDOM.close() }
})

test('custom engine exports a ZIP and run-disable stays separate from visibility', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const originalExport = engineApi.customExport
  const originalDisable = engineApi.customDisable
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  const originalClick = window.HTMLAnchorElement.prototype.click
  const downloads: string[] = []
  const disabled: unknown[] = []
  let refreshed = 0
  engineApi.customExport = async (id) => { assert.equal(id, 'custom_test'); return new Blob(['zip'], { type: 'application/zip' }) }
  engineApi.customDisable = async (id, value) => { disabled.push([id, value]); return {} }
  URL.createObjectURL = () => 'blob:test'
  URL.revokeObjectURL = () => {}
  window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download) }
  try {
    await act(async () => root.render(<I18nProvider><CustomEngineControls engine={{ id: 'custom_test', enabled: true, disabled: false } as import('../src/api/client').EngineInfo} onChanged={async () => { refreshed += 1 }} /></I18nProvider>))
    const buttons = [...document.querySelectorAll('button')]
    await act(async () => buttons[0].click())
    assert.deepEqual(downloads, ['custom_test.zip'])
    await act(async () => buttons[1].click())
    assert.deepEqual(disabled, [['custom_test', true]])
    assert.equal(refreshed, 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
  } finally {
    engineApi.customExport = originalExport; engineApi.customDisable = originalDisable
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke
    window.HTMLAnchorElement.prototype.click = originalClick
    await act(async () => root.unmount()); await window.happyDOM.close()
  }
})
