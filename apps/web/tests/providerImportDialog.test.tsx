import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { providerApi, type ProviderInfo } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import ProviderImportDialog from '../src/components/ProviderImportDialog'

test('provider import dialog loads sources and refreshes after importing a selected provider', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalSources = providerApi.importSources
  const originalImport = providerApi.importFromCcSwitch
  const imported: string[][] = []
  let refreshed = 0
  providerApi.importSources = async () => ({ sources: [{
    id: 'cc-switch', name: 'CC Switch', description: 'Local profiles', provider_count: 1,
    providers: [{
      id: 'provider-1', source_type: 'codex', name: 'Provider One', type: 'custom',
      protocol: 'openai_responses', protocols: ['openai_responses'], base_url: 'https://example.test',
      has_key: true, wire_api: 'responses', model_ids: [], category: 'codex',
      error: null, already_exists: false,
    }],
  }] })
  providerApi.importFromCcSwitch = async (ids) => {
    imported.push(ids)
    return { source: 'cc-switch', imported: [{ id: 'provider-1' } as ProviderInfo], skipped: [], errors: [] }
  }
  try {
    await act(async () => root.render(<I18nProvider><ProviderImportDialog
      types={[]} onClose={() => {}} onImported={() => { refreshed += 1 }}
    /></I18nProvider>))
    const source = container.querySelector<HTMLButtonElement>('.provider-import-source')
    assert.ok(source)
    await act(async () => source.click())
    const candidate = container.querySelector<HTMLButtonElement>('.provider-import-candidate')
    assert.ok(candidate)
    await act(async () => candidate.click())
    assert.equal(candidate.getAttribute('aria-checked'), 'true')
    const submit = container.querySelector<HTMLButtonElement>('.provider-import-submit')
    assert.ok(submit)
    await act(async () => submit.click())
    assert.deepEqual(imported, [['provider-1']])
    assert.equal(refreshed, 1)
  } finally {
    providerApi.importSources = originalSources
    providerApi.importFromCcSwitch = originalImport
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
