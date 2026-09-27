import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { providerApi, type ProviderInfo, type ProviderTypeMeta } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import ProviderEditorDialog from '../src/components/ProviderEditorDialog'

const provider = {
  id: 'original', name: 'Original', type: 'custom', protocol: 'openai_responses',
  protocols: ['openai_responses'], base_url: 'https://example.test',
  protocol_base_urls: { openai_responses: 'https://example.test' }, has_key: true,
} as ProviderInfo

test('copy loads the secret, validates the draft, and saves a new provider', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalReveal = providerApi.reveal
  const originalSave = providerApi.save
  const saved: Parameters<typeof providerApi.save>[0][] = []
  let refreshed = 0
  let closed = 0
  providerApi.reveal = async () => ({ value: 'existing-secret' })
  providerApi.save = async (value) => {
    saved.push(value)
    return { saved: true, provider }
  }
  try {
    await act(async () => root.render(<I18nProvider><ProviderEditorDialog
      target={{ mode: 'copy', provider }} types={[]}
      onClose={() => { closed += 1 }} onSaved={() => { refreshed += 1 }}
    /></I18nProvider>))
    const name = container.querySelector<HTMLInputElement>('#provider-name')
    const key = container.querySelector<HTMLInputElement>('#provider-api-key')
    assert.ok(name)
    assert.ok(key)
    assert.match(name.value, /Original/)
    const save = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('保存'))
    assert.ok(save)
    assert.equal(save.disabled, false)
    await act(async () => save.click())
    assert.equal(saved.length, 1)
    assert.equal(saved[0].id, undefined)
    assert.equal(saved[0].api_key, 'existing-secret')
    assert.equal(saved[0].protocol_base_urls?.openai_responses, 'https://example.test')
    assert.equal(refreshed, 1)
    assert.equal(closed, 1)
  } finally {
    providerApi.reveal = originalReveal
    providerApi.save = originalSave
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('new provider keeps save disabled until required fields are complete', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const types = [{ id: 'custom', label: 'Custom', default_protocols: ['openai_responses'], default_base_url: '' }] as ProviderTypeMeta[]
  try {
    await act(async () => root.render(<I18nProvider><ProviderEditorDialog
      target={{ mode: 'create' }} types={types} onClose={() => {}} onSaved={() => {}}
    /></I18nProvider>))
    const save = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('保存'))
    assert.ok(save)
    assert.equal(save.disabled, true)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('closing an edited provider draft requires discard confirmation', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let closed = 0
  try {
    await act(async () => root.render(<I18nProvider><ProviderEditorDialog
      target={{ mode: 'edit', provider }} types={[]} onClose={() => { closed += 1 }} onSaved={() => {}}
    /></I18nProvider>))
    const protocolSwitch = container.querySelector<HTMLInputElement>('input[role="switch"]')
    assert.ok(protocolSwitch)
    await act(async () => protocolSwitch.click())
    const cancel = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Cancel'))
    assert.ok(cancel)
    await act(async () => cancel.click())
    assert.equal(closed, 0)
    assert.equal(container.querySelectorAll('[role="dialog"]').length, 2)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
