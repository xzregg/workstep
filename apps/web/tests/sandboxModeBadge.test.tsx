import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import SandboxModeBadge from '../src/components/SandboxModeBadge'

for (const running of [true, false, null]) {
  test(`sandbox badge reflects actual runtime: ${running}`, async () => {
    const { document, window } = installDomEnvironment()
    useLocaleStore.setState({ locale: 'zh-CN' })
    if (running !== null) window.workstepDesktop = { notify() {}, sandbox: {
      status: async () => ({ running, settings: { enabled: true } }),
    } } as any
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    try {
      await act(async () => root.render(<I18nProvider><SandboxModeBadge /></I18nProvider>))
      assert.equal(document.body.textContent, running === true ? '沙箱模式' : '')
    } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
  })
}
