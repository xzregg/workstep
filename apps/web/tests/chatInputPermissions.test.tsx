import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
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
