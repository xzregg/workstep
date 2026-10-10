import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import ShareDialog from '../src/components/ShareDialog'
import { I18nProvider } from '../src/i18n'

for (const gateway of [false, true]) test(`share dialog focuses its container instead of password: gateway=${gateway}`, async () => {
  const { window } = installDomEnvironment()
  const element = document.body.appendChild(document.createElement('div'))
  const root = createRoot(element)
  const api = { get: async () => null, create: async () => { throw new Error('unused') }, revoke: async () => {} }
  try {
    await act(async () => root.render(<I18nProvider><ShareDialog open gateway={gateway} taskId="task-1" projectId="p-1" api={api} onClose={() => {}} /></I18nProvider>))
    const dialog = element.querySelector('[role="dialog"]')
    const password = element.querySelector<HTMLInputElement>('input[type="password"]')
    assert.ok(dialog)
    assert.ok(password)
    assert.equal(document.activeElement, dialog)
    password.focus()
    await act(async () => root.render(<I18nProvider><ShareDialog open gateway={gateway} taskId="task-1" projectId="p-1" api={api} onClose={() => {}} /></I18nProvider>))
    assert.equal(document.activeElement, password)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
