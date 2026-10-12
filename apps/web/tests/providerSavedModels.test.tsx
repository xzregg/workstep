import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import ProviderSavedModels from '../src/components/ProviderSavedModels'
import ProviderSettings from '../src/pages/ProviderSettings'
import { providerApi, type ProviderInfo } from '../src/api/client'
import type { ProviderProtocolModels } from '../src/utils/providerModels'

const groups: ProviderProtocolModels[] = [
  { protocol: 'openai_chat_completions', fetchedAt: null, models: [
    { id: 'shared', label: 'Chat model', description: 'Chat description' },
    { id: 'chat-only', label: 'Chat only' },
  ] },
  { protocol: 'openai_responses', fetchedAt: null, models: [
    { id: 'shared', label: 'Responses model' },
    { id: 'response-only', label: '' },
  ] },
]

test('saved model details stack above the settings overlay regardless of stylesheet order', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const baseCss = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')
  const baseOverlay = baseCss.match(/\.modal-overlay\s*\{[^}]+\}/)?.[0]
  assert.ok(baseOverlay)
  const modelCss = await readFile(new URL('../src/components/ProviderSavedModels.css', import.meta.url), 'utf8')
  const settingsCss = await readFile(new URL('../src/pages/SettingsPage.css', import.meta.url), 'utf8')
  const style = document.head.appendChild(document.createElement('style'))
  try {
    await act(async () => root.render(<I18nProvider><div className="modal-overlay settings-dialog-overlay">
      <ProviderSavedModels providerName="Demo" groups={groups} protocolLabel={(protocol) => protocol} />
    </div></I18nProvider>))
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click())
    const settings = container.querySelector<HTMLElement>('.settings-dialog-overlay')!
    const details = document.body.querySelector<HTMLElement>('.provider-saved-models-overlay')!
    for (const css of [`${baseOverlay}\n${settingsCss}\n${modelCss}`, `${modelCss}\n${baseOverlay}\n${settingsCss}`]) {
      style.textContent = css
      assert.ok(Number(window.getComputedStyle(details).zIndex) > Number(window.getComputedStyle(settings).zIndex), 'model details must be above settings')
    }
  } finally {
    await act(async () => root.unmount())
    style.remove()
    container.remove()
    await window.happyDOM.close()
  }
})

test('saved models show only a deduplicated count until opened, then preserve protocol groups', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><ProviderSavedModels
      providerName="Demo provider" groups={groups}
      protocolLabel={(protocol) => protocol}
    /></I18nProvider>))
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')
    assert.ok(trigger)
    assert.match(trigger.textContent ?? '', /3/)
    assert.equal(container.querySelector('[role="list"]'), null)
    assert.doesNotMatch(container.textContent ?? '', /Chat model|chat-only/)
    trigger.focus()
    await act(async () => trigger.click())
    const dialog = document.body.querySelector('[role="dialog"]')
    assert.ok(dialog)
    assert.match(dialog.getAttribute('aria-label') ?? '', /Demo provider/)
    assert.equal(container.querySelector('[role="dialog"]'), null, 'portal avoids disabled-card opacity')
    const lists = dialog.querySelectorAll('[data-model-protocol]')
    assert.equal(lists.length, 2)
    assert.match(lists[0].textContent ?? '', /shared/)
    assert.match(lists[1].textContent ?? '', /shared/)
    assert.match(lists[1].textContent ?? '', /response-only/)
    assert.equal(dialog.querySelector('input[type="checkbox"]'), null, 'details are read-only')
    assert.equal(dialog.querySelector('[title="Chat description"] button')?.textContent, 'shared')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(document.body.querySelector('[role="dialog"]'), null)
    assert.equal(document.activeElement, trigger)
    await act(async () => trigger.click())
    await act(async () => document.body.querySelector('[role="dialog"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    assert.equal(document.body.querySelector('[role="dialog"]'), null)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('model tags wrap horizontally and copy the canonical model name with success and failure feedback', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const copied: string[] = []
  let fail = false
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: {
    writeText: async (value: string) => { if (fail) throw new Error('denied'); copied.push(value) },
  } })
  const style = document.head.appendChild(document.createElement('style'))
  style.textContent = await readFile(new URL('../src/components/ProviderSavedModels.css', import.meta.url), 'utf8')
  try {
    await act(async () => root.render(<I18nProvider><ProviderSavedModels
      providerName="Demo" groups={groups} protocolLabel={(protocol) => protocol}
    /></I18nProvider>))
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click())
    const dialog = document.body.querySelector('[role="dialog"]')!
    const list = dialog.querySelector<HTMLElement>('.provider-saved-models-list')!
    assert.equal(window.getComputedStyle(list).display, 'flex')
    assert.equal(window.getComputedStyle(list).flexWrap, 'wrap')
    const tags = dialog.querySelectorAll<HTMLButtonElement>('.provider-saved-models-tag')
    assert.equal(tags.length, 4)
    assert.equal(tags[0].textContent, 'shared')
    await act(async () => tags[0].click())
    assert.deepEqual(copied, ['shared'], 'copy the actual model name, not its display alias')
    assert.match(dialog.querySelector('[role="status"]')?.textContent ?? '', /(?:Copied|已复制).*shared/)
    await act(async () => tags[1].click())
    assert.deepEqual(copied, ['shared', 'chat-only'])
    assert.match(dialog.querySelector('[role="status"]')?.textContent ?? '', /chat-only/)
    fail = true
    await act(async () => tags[3].click())
    const failure = dialog.querySelector('[role="alert"]')
    assert.ok(failure)
    assert.match(failure.textContent ?? '', /response-only/)
    assert.doesNotMatch(failure.textContent ?? '', /Copied|已复制/)
    assert.deepEqual(copied, ['shared', 'chat-only'])
  } finally {
    await act(async () => root.unmount())
    style.remove()
    container.remove()
    await window.happyDOM.close()
  }
})

test('empty saved model groups do not offer an empty details dialog', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><ProviderSavedModels
      providerName="Empty" groups={[]} protocolLabel={(protocol) => protocol}
    /></I18nProvider>))
    assert.equal(container.querySelector('button'), null)
    assert.equal(document.body.querySelector('[role="dialog"]'), null)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('provider page opens saved details without refreshing models or changing discovery controls', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalList = providerApi.list
  const originalModels = providerApi.models
  const originalPreview = providerApi.previewModels
  const provider: ProviderInfo = {
    id: 'demo', name: 'Demo', type: 'custom', protocol: 'openai_chat_completions',
    protocols: groups.map((group) => group.protocol), base_url: 'https://example.test/v1',
    api_key: '', has_key: true, enabled: false, verified: false, created_at: '',
    model_count: 3, models_fetched_at: '2026-10-01T00:00:00Z',
  }
  let reads = 0
  let previews = 0
  providerApi.list = async () => ({ providers: [provider], types: [] })
  providerApi.models = async (_id, _refresh, protocol) => {
    reads += 1
    return { provider_id: provider.id, models: groups.find((group) => group.protocol === protocol)!.models, fetched_at: provider.models_fetched_at }
  }
  providerApi.previewModels = async () => {
    previews += 1
    return { provider_id: provider.id, models: groups[0].models, fetched_at: null }
  }
  try {
    await act(async () => root.render(<I18nProvider><ProviderSettings /></I18nProvider>))
    assert.equal(reads, 2)
    const card = container.querySelector('[data-provider-id="demo"]')
    assert.ok(card)
    assert.doesNotMatch(card.textContent ?? '', /Chat model|Responses model/)
    const count = card.querySelector<HTMLButtonElement>('.provider-saved-models-count')
    assert.ok(count)
    await act(async () => count.click())
    assert.ok(document.body.querySelector('[role="dialog"]'))
    assert.equal(reads, 2)
    assert.equal(previews, 0)
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    const fetch = Array.from(card.querySelectorAll<HTMLButtonElement>('.provider-settings-card-actions button'))
      .find((button) => button.textContent?.includes('获取模型'))
    assert.ok(fetch)
    await act(async () => fetch.click())
    assert.equal(previews, 1)
    assert.ok(document.body.querySelector('input[type="checkbox"]'), 'discovery still offers the original selection dialog')
  } finally {
    providerApi.list = originalList
    providerApi.models = originalModels
    providerApi.previewModels = originalPreview
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
