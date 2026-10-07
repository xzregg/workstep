import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import SandboxImagePicker from '../src/components/SandboxImagePicker'

test('Docker scan is explicit and selection returns the immutable image ID', async () => {
  const { document, window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const id = 'sha256:' + 'a'.repeat(64)
  let scans = 0, selected: string | null = null
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><SandboxImagePicker value={null} online={false} disabled={false} onChange={value => { selected = value }} scan={async () => { scans++; return { images: [{ id, tags: ['workstep:latest'], size: 1024 }], error: null } }} /></I18nProvider>))
    assert.equal(scans, 0)
    await act(async () => document.querySelector('button')!.click())
    assert.equal(scans, 1)
    const select = document.querySelector('select')!
    await act(async () => { select.value = id; select.dispatchEvent(new window.Event('change', { bubbles: true })) })
    assert.equal(selected, id)
    assert.match(document.body.textContent!, /workstep:latest/)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})
