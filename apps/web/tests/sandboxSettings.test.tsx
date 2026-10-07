import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import SandboxSettings from '../src/components/SandboxSettings'
import type { SandboxStatus } from '../src/utils/desktopSandbox'

test('sandbox preparation is explicit, mode switching confirms, and failures preserve retry', async () => {
  const { document, window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  let current: SandboxStatus = { settings: { enabled: false, root: '', project: '', mounts: [] }, phase: 'idle', progress: null, error: null, running: false, supported: true }
  let reads = 0, prepared = 0, switches = 0, selected = 0, fail = true
  const choices = ['/sandbox', '/project']
  window.workstepDesktop = { notify() {}, sandbox: {
    status: async () => { reads++; return current },
    dockerImages: async () => ({ images: [], error: null }),
    chooseDirectory: async () => choices[selected++]!,
    prepare: async settings => {
      prepared++
      if (fail) throw new Error('下载失败')
      current = { ...current, phase: 'ready', settings: { ...settings, prepared: true } }; return current
    },
    switchMode: async () => { switches++ },
    importConfig: async () => current, remove: async () => current, logs: async () => {},
  } }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent === text)!
  try {
    await act(async () => root.render(<I18nProvider><SandboxSettings /></I18nProvider>))
    assert.equal(reads, 1)
    assert.equal(button('下载并准备沙箱').disabled, true)
    await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === '选择目录')!.click())
    await act(async () => [...document.querySelectorAll('button')].filter(b => b.textContent === '选择目录')[1]!.click())
    assert.equal(prepared, 0)
    await act(async () => button('下载并准备沙箱').click())
    assert.match(document.body.textContent!, /下载失败/)
    assert.equal(button('下载并准备沙箱').disabled, false)
    fail = false
    await act(async () => button('下载并准备沙箱').click())
    await act(async () => button('开启沙箱并重启').click())
    assert.equal(switches, 0)
    assert.ok(document.querySelector('[role="dialog"]'))
    await act(async () => button('确认').click())
    assert.equal(switches, 1)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

test('ordinary browser has no sandbox controls', async () => {
  const { document, window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><SandboxSettings /></I18nProvider>))
    assert.equal(document.body.textContent, '')
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})
