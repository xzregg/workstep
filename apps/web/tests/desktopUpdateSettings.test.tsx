import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import DesktopUpdateSettings from '../src/components/DesktopUpdateSettings'

test('automatic update is explicit, displays progress, prevents repeat clicks and offers retry', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN', language: null })
  const node = document.body.appendChild(document.createElement('div')), root = createRoot(node)
  let starts = 0, reject!: (error: Error) => void
  const status = { currentVersion: '1.0.0', latestVersion: '2.0.0', updateAvailable: true,
    checkedAt: 1, releaseUrl: 'https://github.com/xzregg/workstep/releases/latest', source: 'network' as const }
  window.workstepDesktop = { updates: {
    status: async () => status, check: async () => status, openDownload: async () => {},
    autoStatus: async () => ({ phase: starts ? 'downloading' : 'idle', percent: starts ? 43 : 0, error: null }),
    start: () => { starts++; return new Promise<void>((_, fail) => { reject = fail }) },
  } }
  try {
    await act(async () => root.render(<I18nProvider><DesktopUpdateSettings /></I18nProvider>))
    assert.equal(starts, 0)
    const button = () => [...node.querySelectorAll('button')].find(b => /自动更新|下载中/.test(b.textContent!))!
    await act(async () => button().click())
    assert.equal(starts, 1)
    assert.equal(button().disabled, true)
    assert.match(node.textContent!, /43%/)
    await act(async () => reject(new Error('网络连接失败')))
    assert.match(node.textContent!, /网络连接失败/)
    assert.equal(button().disabled, false)
    assert.match(node.textContent!, /GitHub/)
  } finally {
    await act(async () => root.unmount()); node.remove(); await window.happyDOM.close()
  }
})


test('automatic check switch saves its value and manual checking remains available', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN', language: null })
  const node = document.body.appendChild(document.createElement('div')), root = createRoot(node)
  let enabled = true, checks = 0
  const status = () => ({ currentVersion: '1.0.0', latestVersion: '', updateAvailable: false,
    checkedAt: 0, releaseUrl: '', source: 'cache' as const, automaticCheckEnabled: enabled })
  window.workstepDesktop = { updates: {
    status: async () => status(), check: async () => { checks++; return status() },
    openDownload: async () => {},
    setAutomaticCheckEnabled: async value => { enabled = value; return status() },
  } }
  try {
    await act(async () => root.render(<I18nProvider><DesktopUpdateSettings /></I18nProvider>))
    const toggle = () => node.querySelector<HTMLButtonElement>('[role="switch"]')!
    assert.equal(toggle().getAttribute('aria-checked'), 'true')
    await act(async () => toggle().click())
    assert.equal(enabled, false)
    assert.equal(toggle().getAttribute('aria-checked'), 'false')
    assert.doesNotMatch(node.textContent!, /当前已是最新版本/)
    const manual = [...node.querySelectorAll('button')].find(b => b.textContent === '检查更新')!
    await act(async () => manual.click())
    assert.equal(checks, 1)
    assert.equal(toggle().getAttribute('aria-checked'), 'false')
    await act(async () => toggle().click())
    assert.equal(enabled, true)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})


test('failed preference save keeps the previous switch value and allows retry', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN', language: null })
  const node = document.body.appendChild(document.createElement('div')), root = createRoot(node)
  let fail = true
  const status = { currentVersion: '1.0.0', latestVersion: '', updateAvailable: false,
    checkedAt: 0, releaseUrl: '', source: 'cache' as const, automaticCheckEnabled: true }
  window.workstepDesktop = { updates: {
    status: async () => status, check: async () => status, openDownload: async () => {},
    setAutomaticCheckEnabled: async value => {
      if (fail) throw new Error('write failed')
      return { ...status, automaticCheckEnabled: value }
    },
  } }
  try {
    await act(async () => root.render(<I18nProvider><DesktopUpdateSettings /></I18nProvider>))
    const toggle = node.querySelector<HTMLButtonElement>('[role="switch"]')!
    await act(async () => toggle.click())
    assert.equal(toggle.getAttribute('aria-checked'), 'true')
    assert.equal(toggle.disabled, false)
    assert.ok(node.querySelector('.settings-system-feedback--error'))
    fail = false
    await act(async () => toggle.click())
    assert.equal(toggle.getAttribute('aria-checked'), 'false')
    assert.equal(node.querySelector('.settings-system-feedback--error'), null)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})
