import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import DesktopUpdateRailAction from '../src/components/DesktopUpdateRailAction'
import DesktopUpdateSettings from '../src/components/DesktopUpdateSettings'

for (const available of [null, false, true]) test(`rail update visibility: ${available}`, async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN', language: null })
  const node = document.body.appendChild(document.createElement('div')), root = createRoot(node)
  let starts = 0
  if (available !== null) window.workstepDesktop = { updates: {
    status: async () => ({ currentVersion: '1.0.0', latestVersion: available ? '2.0.0' : '1.0.0',
      updateAvailable: available, checkedAt: 1, source: 'network', releaseUrl: '' }),
    check: async () => { throw new Error('must reuse status') }, openDownload: async () => {},
    start: async () => { starts++ }, autoStatus: async () => ({ phase: 'idle', percent: 0, error: null }),
  } }
  try {
    await act(async () => root.render(<I18nProvider><DesktopUpdateRailAction onOpenSettings={() => {}} /></I18nProvider>))
    assert.equal(!!node.querySelector('button'), available === true)
    assert.equal(starts, 0, 'checking must never start a download')
    if (available) assert.match(node.textContent!, /2.0.0/)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

test('rail and settings share detection, progress, download guard and errors', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN', language: null })
  const node = document.body.appendChild(document.createElement('div')), root = createRoot(node)
  let checks = 0, starts = 0, reject!: (error: Error) => void
  const opened: string[] = []
  window.workstepDesktop = { updates: {
    status: async () => { checks++; return { currentVersion: '1.0.0', latestVersion: '2.0.0',
      updateAvailable: true, checkedAt: 1, source: 'network', releaseUrl: '' } },
    check: async () => { throw new Error('unexpected check') }, openDownload: async () => {},
    start: () => { starts++; return new Promise<void>((_, fail) => { reject = fail }) },
    autoStatus: async () => ({ phase: starts ? 'downloading' : 'idle', percent: starts ? 43 : 0, error: null }),
  } }
  try {
    await act(async () => root.render(<I18nProvider><DesktopUpdateRailAction onOpenSettings={section => opened.push(section)} /><DesktopUpdateSettings /></I18nProvider>))
    assert.equal(checks, 1)
    const rail = node.querySelector<HTMLButtonElement>('.desktop-update-rail-button')!
    await act(async () => rail.click())
    assert.equal(starts, 1)
    assert.equal(rail.disabled, true)
    assert.match(rail.getAttribute('aria-label')!, /43%/)
    assert.equal(node.querySelector<HTMLButtonElement>('.desktop-update-settings .btn-primary')!.disabled, true)
    await act(async () => reject(new Error('网络连接失败')))
    assert.deepEqual(opened, ['system'])
    assert.match(node.querySelector('[role="alert"]')!.textContent!, /网络连接失败/)
    assert.equal(rail.disabled, false)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})
