import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import SandboxConfigSync from '../src/components/SandboxConfigSync'
import type { SandboxBridge, SandboxConfigImport, SandboxStatus } from '../src/utils/desktopSandbox'

test('configuration sync names .agents explicitly and confirms custom paths, cancellation, errors and retry', async () => {
  const { document, window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  let canceled = true, fail = true, busy = false, synced = 0
  const inputs: SandboxConfigImport[] = []
  const status = { running: true, configSyncVersion: 1 } as SandboxStatus
  const bridge = {
    chooseConfigDirectory: async () => canceled ? null : { source: '/users/demo/.qoder', name: '.qoder' },
    importConfig: async (input: SandboxConfigImport) => { inputs.push(input); if (fail) throw new Error('当前有任务或会话运行'); return {} as SandboxStatus },
  } as SandboxBridge
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent === text)!
  try {
    await act(async () => root.render(<I18nProvider><SandboxConfigSync bridge={bridge} status={status} disabled={false} onBusyChange={value => { busy = value }} onSynced={() => { synced++ }} /></I18nProvider>))
    assert.ok(button('同步 .agents 目录'))
    assert.ok(!document.body.textContent!.includes('共享配置'))
    await act(async () => button('同步其他目录…').click())
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(busy, false)
    canceled = false
    await act(async () => button('同步其他目录…').click())
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /\/users\/demo\/\.qoder/)
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /\/root\/\.qoder/)
    assert.equal(inputs.length, 0)
    await act(async () => button('取消').click())
    assert.equal(inputs.length, 0)
    await act(async () => button('同步其他目录…').click())
    await act(async () => button('确认').click())
    assert.deepEqual(inputs, [{ source: '/users/demo/.qoder' }])
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /当前有任务或会话运行/)
    assert.ok(document.querySelector('[role="dialog"]'))
    assert.equal(busy, false)
    fail = false
    await act(async () => button('确认').click())
    assert.equal(synced, 1)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    for (const [label, kind] of [['导入 Codex 配置', 'codex'], ['导入 Claude 配置', 'claude'], ['同步 .agents 目录', 'agents']] as const) {
      await act(async () => button(label).click())
      await act(async () => button('确认').click())
      assert.equal(inputs.at(-1), kind)
    }
    await act(async () => root.render(<I18nProvider><SandboxConfigSync bridge={bridge} status={status} disabled onBusyChange={() => {}} onSynced={() => {}} /></I18nProvider>))
    assert.equal(button('同步其他目录…').disabled, true)
    assert.equal(button('导入 Codex 配置').disabled, true)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

for (const hasNewPicker of [false, true]) test(`older desktop runtime explains restart before live sync (new picker=${hasNewPicker})`, async () => {
  const { document, window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  let busy = false, imports = 0, legacyPickerCalls = 0, configPickerCalls = 0
  const bridge = {
    chooseDirectory: async () => { legacyPickerCalls++; return '/users/demo/.qoder' },
    ...(hasNewPicker ? { chooseConfigDirectory: async () => { configPickerCalls++; return { source: '/users/demo/.qoder', name: '.qoder' } } } : {}),
    importConfig: async (input: SandboxConfigImport) => { assert.equal(input, 'codex'); imports++; return {} as SandboxStatus },
  } as SandboxBridge
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent === text)!
  try {
    const render = (running: boolean) => root.render(<I18nProvider><SandboxConfigSync bridge={bridge} status={{ running } as SandboxStatus} disabled={false} onBusyChange={value => { busy = value }} onSynced={() => {}} /></I18nProvider>)
    await act(async () => render(true))
    await act(async () => button('同步其他目录…').click())
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /完全退出.*重新打开/)
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /刷新页面/)
    assert.ok(!document.body.textContent!.includes('is not a function'))
    assert.equal(busy, false)
    assert.equal(legacyPickerCalls, 0)
    assert.equal(configPickerCalls, 0)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    await act(async () => button('导入 Codex 配置').click())
    await act(async () => button('确认').click())
    assert.equal(imports, 0)
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /完全退出.*重新打开/)
    await act(async () => button('取消').click())
    await act(async () => render(false))
    await act(async () => button('导入 Codex 配置').click())
    await act(async () => button('确认').click())
    assert.equal(imports, 1)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})
