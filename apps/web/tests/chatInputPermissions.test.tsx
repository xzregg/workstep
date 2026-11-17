import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import ChatInput from '../src/components/ChatInput'
import { I18nProvider, zhCNT } from '../src/i18n'
import type { CoordinatorEngineSummary } from '../src/api/task'

for (const width of [320, 390, 1023, 1024, 1440]) test(`permission choices follow engine declarations at ${width}px`, async () => {
  const { window } = installDomEnvironment()
  Object.assign(globalThis, { history: window.history })
  window.happyDOM.setWindowSize({ width, height: 844 })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const selected: string[] = []
  const engine: CoordinatorEngineSummary = {
    id: 'custom-example', mode: 'sdk', installed: true, configured: true,
    verified: true, built_in: false, supports_coordinator: true,
    supports_session_fork: false, supports_provider: false, provider_protocols: [],
    permission_modes: ['auto', 'ask'],
  }
  try {
    await act(async () => root.render(<I18nProvider><ChatInput
      value="" onChange={() => {}} onSend={() => {}}
      config={{ engines: [engine], engine: '', defaultEngine: engine.id, model: '', fastModel: '',
        onEngineChange: () => {}, onModelChange: () => {}, onFastModelChange: () => {} }}
      permission={{ value: 'danger-full-access', onChange: mode => selected.push(mode) }}
    /></I18nProvider>))
    // A saved unsupported selection must retain its real label, not pretend to be default.
    const trigger = container.querySelector<HTMLButtonElement>('[data-kind="permission"]')!
    assert.ok(trigger.textContent?.includes(zhCNT('chatSession.permissionFullAccess')))
    await act(async () => trigger.click())
    const choices = [...document.querySelectorAll<HTMLButtonElement>('.chat-input-menu-item')]
    assert.equal(choices.length, 3)
    assert.deepEqual(choices.map(item => item.textContent?.trim()), [
      zhCNT('chatSession.permissionDefault'), zhCNT('chatSession.permissionAuto'), zhCNT('chatSession.permissionAsk'),
    ])
    await act(async () => choices[2].click())
    assert.deepEqual(selected, ['ask'])
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


for (const supported of [true, false]) test(`service tier follows capability: ${supported}`, async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const { default: CoordinatorConfigBar } = await import('../src/components/CoordinatorConfigBar')
  try {
    await act(async () => root.render(<I18nProvider><CoordinatorConfigBar
      engines={[{ id: 'custom-speed', supports_service_tier: supported } as CoordinatorEngineSummary]}
      engine="custom-speed" defaultEngine="" model="" fastModel=""
      onEngineChange={() => {}} onModelChange={() => {}} onFastModelChange={() => {}}
      onServiceTierChange={() => {}}
    /></I18nProvider>))
    const speed = [...container.querySelectorAll('select')].find(select =>
      [...select.options].some(option => option.value === 'ultrafast'))
    assert.equal(Boolean(speed), supported)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


for (const width of [320, 390, 1023, 1024, 1440]) test(`native fields remain selectable at ${width}px`, async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width, height: 844 })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const selected: string[] = []
  const engine = {
    id: 'native-custom', installed: true, configured: true,
    permission_config_options: [{ id: 'guard', name: '原生权限', type: 'select', currentValue: 'review',
      options: [{ value: 'review', name: '审核' }, { value: 'trust', name: '信任' }] }],
  } as CoordinatorEngineSummary
  try {
    await act(async () => root.render(<I18nProvider><ChatInput
      value="" onChange={() => {}} onSend={() => {}}
      config={{ engines: [engine], engine: engine.id, defaultEngine: '', model: '', fastModel: '',
        onEngineChange: () => {}, onModelChange: () => {}, onFastModelChange: () => {} }}
      permission={{ value: '', onChange: value => selected.push(value) }}
    /></I18nProvider>))
    const trigger = container.querySelector<HTMLButtonElement>('[data-kind="permission"]')!
    assert.ok(trigger.textContent?.includes(zhCNT('enginePermission.inherit')))
    await act(async () => trigger.click())
    const choices = [...document.querySelectorAll<HTMLButtonElement>('.chat-input-menu-item')]
    assert.equal(choices.length, 3)
    await act(async () => choices[2].click())
    const { permissionSelection } = await import('../src/utils/enginePermissions')
    assert.deepEqual(permissionSelection(engine.id, selected[0]), { guard: 'trust' })
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('engine selection remains available when engine declares no permission controls', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><ChatInput value="" onChange={() => {}} onSend={() => {}}
      config={{ engines: [{ id: 'hermes', installed: true, configured: true, permission_config_options: [] } as unknown as CoordinatorEngineSummary],
        engine: 'hermes', defaultEngine: '', model: '', fastModel: '', onEngineChange: () => {}, onModelChange: () => {}, onFastModelChange: () => {} }}
      permission={{ value: '', onChange: () => {} }} /></I18nProvider>))
    assert.equal(container.querySelector('[data-kind="permission"]'), null)
    assert.ok(container.textContent?.includes('Hermes'))
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


for (const engineId of ['claude', 'claude_agent_sdk']) test(`${engineId} full access can be selected in composer and saved in engine settings`, async () => {
  const { window } = installDomEnvironment()
  const { useLocaleStore } = await import('../src/i18n')
  useLocaleStore.getState().setLocale('zh-CN')
  const { engineApi } = await import('../src/api/client')
  const { default: EngineConfigForm } = await import('../src/components/EngineConfigForm')
  const originalSave = engineApi.saveConfig
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const selected: string[] = []
  const modes = ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']
  const field = { id: 'permission_mode', name: '权限模式', type: 'select' as const,
    currentValue: 'manual', options: modes.map(value => ({value, name: value})) }
  const engine = { id: engineId, installed: true, configured: true, permission_config_options: [field] } as CoordinatorEngineSummary
  let saved: unknown
  const form = createRef<import('../src/components/EngineConfigForm').EngineConfigFormHandle>()
  try {
    await act(async () => root.render(<I18nProvider><ChatInput value="" onChange={() => {}} onSend={() => {}}
      config={{ engines: [engine], engine: engineId, defaultEngine: '', model: '', fastModel: '',
        onEngineChange: () => {}, onModelChange: () => {}, onFastModelChange: () => {} }}
      permission={{ value: '', onChange: value => selected.push(value) }}
      plan={{active: false, onChange: () => {}}} /></I18nProvider>))
    await act(async () => (document.querySelector('[data-kind="permission"]') as HTMLButtonElement).click())
    const choices = [...document.querySelectorAll<HTMLButtonElement>('.chat-input-menu-item')]
    assert.equal(choices.length, 6) // inherit + five permission modes; plan has its own composer control
    const full = choices.find(choice => choice.textContent?.includes('全权限（免审批）'))
    assert.ok(full)
    assert.ok(full.textContent?.includes('bypassPermissions'))
    await act(async () => full.click())
    const { permissionSelection } = await import('../src/utils/enginePermissions')
    assert.deepEqual(permissionSelection(engineId, selected[0]), {permission_mode: 'bypassPermissions'})
    const config = { fields: [{ key: field.id, label: field.name, type: 'select' as const, category: 'mode',
      options: modes.map(value => ({value, label: value})), required: true, placeholder: '', help: '',
      default: '', sensitive: false, confirm_values: ['bypassPermissions'] }],
      step_fields: [], values: {permission_mode: 'manual'}, secrets: {} }
    engineApi.saveConfig = async (id, input) => {
      assert.equal(id, engineId)
      saved = input
      return { ...config, engine_id: id, values: input.values, installed: true, configured: true, saved: true, engine: {} as never }
    }
    await act(async () => root.render(<I18nProvider><EngineConfigForm ref={form} engineId={engineId} config={config} /></I18nProvider>))
    const select = document.querySelector('select')!
    assert.deepEqual([...select.options].filter(option => option.value).map(option => option.value), modes.filter(mode => mode !== 'plan'))
    assert.equal([...select.options].find(option => option.value === 'bypassPermissions')?.textContent, '全权限（免审批）')
    await act(async () => {
      select.value = 'bypassPermissions'
      select.dispatchEvent(new window.Event('change', {bubbles: true}))
    })
    await act(async () => form.current?.save())
    assert.equal(saved, undefined)
    await act(async () => (document.querySelector('.confirm-dialog-confirm') as HTMLButtonElement).click())
    assert.deepEqual(saved, {values: {permission_mode: 'bypassPermissions'}, clear: {}, confirmed: {permission_mode: true}})
  } finally {
    engineApi.saveConfig = originalSave
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


for (const engineId of ['claude', 'claude_agent_sdk']) test(`${engineId} step permission notes show original mode names and keep native selection`, async () => {
  const { window } = installDomEnvironment()
  const { useLocaleStore } = await import('../src/i18n')
  useLocaleStore.getState().setLocale('zh-CN')
  window.happyDOM.setWindowSize({width: 390, height: 844})
  const { default: StepConfigFields } = await import('../src/components/StepConfigFields')
  const modes = ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']
  const field = { key: 'permission_mode', label: '权限模式', type: 'select' as const, category: 'mode',
    options: modes.map(value => ({value, label: value})), required: true, placeholder: '', help: '',
    default: '', sensitive: false, confirm_values: ['bypassPermissions'] }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const changes: string[] = []
  try {
    await act(async () => root.render(<I18nProvider><StepConfigFields engineId={engineId} fields={[field]} values={{}}
      onChange={(_key, value) => changes.push(value)} /></I18nProvider>))
    await act(async () => (document.querySelector('.skin-select-trigger') as HTMLButtonElement).click())
    assert.equal(document.querySelector('[role="option"][data-value="plan"]'), null)
    for (const mode of modes.filter(mode => mode !== 'plan')) {
      const option = document.querySelector(`[role="option"][data-value="${mode}"]`)!
      assert.ok(option.querySelector('.skin-select-option-description')?.textContent?.includes(mode))
    }
    await act(async () => {
      const search = document.querySelector('.skin-select-search') as HTMLInputElement
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'bypassPermissions')
      search.dispatchEvent(new window.Event('input', {bubbles: true}))
    })
    assert.equal(document.querySelectorAll('[role="option"]').length, 1)
    await act(async () => (document.querySelector('[data-value="bypassPermissions"]') as HTMLButtonElement).click())
    assert.deepEqual(changes, ['bypassPermissions'])
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
