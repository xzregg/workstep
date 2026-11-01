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
