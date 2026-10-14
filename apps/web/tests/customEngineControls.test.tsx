import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { chatSessionApi, engineApi } from '../src/api/client'
import { useChatListStore } from '../src/stores/chatSessionStore'
import { useProjectStore } from '../src/stores/projectStore'
import CustomEngineControls from '../src/components/CustomEngineControls'
import CustomEngineOnboardingButton from '../src/components/CustomEngineOnboardingButton'
import { loadDraft } from '../src/utils/chatDraft'
function Location() { return <output>{useLocation().search}</output> }
for (const importing of [false, true]) {
  test(`${importing ? 'import' : 'onboarding'} refreshes an already cached sidebar list after creation`, async () => {
    const { window } = installDomEnvironment()
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    const originalCreate = engineApi.customOnboarding
    const originalImport = engineApi.customImport
    const originalList = chatSessionApi.list
    const projectState = useProjectStore.getState()
    const listState = useChatListStore.getState()
    const session = {
      id: 'new-session', project_id: 'runtime', workflow_id: '', title: '自定义引擎接入',
      engine: 'codex_sdk', model: null, message_count: 0,
      created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z',
    }
    let requests = 0
    const result = { project_id: 'runtime', project_name: '默认工作区', session_id: session.id, workspace_path: '/runtime', package_path: '/runtime/imported', prompt: '接入' }
    engineApi.customOnboarding = async () => result
    engineApi.customImport = async () => result
    chatSessionApi.list = async (projectId) => {
      assert.equal(projectId, 'runtime')
      requests += 1
      return { sessions: [session] }
    }
    useProjectStore.setState({ fetchProjects: async () => {} })
    useChatListStore.setState({ sessionsByProject: { runtime: [] }, listLoadingByProject: {}, selectedIds: new Set(['selected']), selectionProjectId: 'other-project' })
    try {
      await act(async () => root.render(<MemoryRouter><I18nProvider><CustomEngineOnboardingButton /><Location /></I18nProvider></MemoryRouter>))
      if (importing) {
        const input = document.querySelector<HTMLInputElement>('input[type=file]')!
        Object.defineProperty(input, 'files', { value: [new window.File(['zip'], 'engine.zip')] })
        await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })))
      } else {
        await act(async () => document.querySelector<HTMLButtonElement>('button')!.click())
      }
      assert.equal(requests, 1)
      assert.deepEqual(useChatListStore.getState().sessionsByProject.runtime.map(item => item.id), ['new-session'])
      assert.deepEqual([...useChatListStore.getState().selectedIds], ['selected'])
      assert.match(document.querySelector('output')!.textContent!, /session=new-session/)
    } finally {
      engineApi.customOnboarding = originalCreate; engineApi.customImport = originalImport; chatSessionApi.list = originalList
      useProjectStore.setState(projectState); useChatListStore.setState(listState)
      await act(async () => root.unmount()); await window.happyDOM.close()
    }
  })
}

test('engine import selects a ZIP, prefills acceptance draft and opens ordinary chat', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = engineApi.customImport
  const file = new window.File(['zip'], 'engine.zip', { type: 'application/zip' })
  let closed = 0
  engineApi.customImport = async (selected) => {
    assert.equal(selected, file)
    return { project_id: 'runtime', project_name: '默认工作区', session_id: 'imported', workspace_path: '/runtime', package_path: '/runtime/imported', prompt: '请验收 /runtime/imported 后注册' }
  }
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><CustomEngineOnboardingButton onStarted={() => { closed += 1 }} /><Location /></I18nProvider></MemoryRouter>))
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!
    assert.match(input.accept, /\.zip/)
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })))
    assert.equal(loadDraft('imported'), '请验收 /runtime/imported 后注册')
    assert.match(document.querySelector('output')!.textContent!, /session=imported/)
    assert.equal(closed, 1)
    assert.equal(input.value, '')
  } finally { engineApi.customImport = original; await act(async () => root.unmount()); await window.happyDOM.close() }
})

test('engine import failure remains retryable in settings', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = engineApi.customImport
  engineApi.customImport = async () => { throw new Error('ZIP 包无效') }
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><CustomEngineOnboardingButton /></I18nProvider></MemoryRouter>))
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', { value: [new window.File(['bad'], 'engine.zip')] })
    await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })))
    assert.equal(document.querySelector('[role=alert]')!.textContent, 'ZIP 包无效')
    assert.ok([...document.querySelectorAll('button')].every(button => !button.disabled))
    assert.equal(input.value, '')
  } finally { engineApi.customImport = original; await act(async () => root.unmount()); await window.happyDOM.close() }
})

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
