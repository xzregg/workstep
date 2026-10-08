import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { engineApi, type EngineInfo } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import ExecutionDefaultSettings from '../src/components/ExecutionDefaultSettings'

for (const configuredEngine of ['codex', '']) {
  test(`execution default settings resolves ${configuredEngine || 'empty config'} and saves an engine`, async () => {
    const { window } = installDomEnvironment()
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    const originalGet = engineApi.executionConfig
    const originalSave = engineApi.setExecutionConfig
    let loaded = 0
    let saved = ''
    let changed = 0
    engineApi.executionConfig = async () => { loaded += 1; return { engine: configuredEngine, resolved_engine: configuredEngine || 'pydantic_ai' } }
    engineApi.setExecutionConfig = async (engine) => { saved = engine; return { engine } }
    try {
      const engines = [{ id: 'codex', installed: true, configured: true, verified: true,
        built_in: false, mode: 'cli' },
        { id: 'pydantic_ai', installed: true, configured: true, verified: true,
          built_in: true, mode: 'agent' }] as EngineInfo[]
      await act(async () => root.render(<I18nProvider><ExecutionDefaultSettings
        engines={engines} loading={false} onChanged={() => { changed += 1 }}
      /></I18nProvider>))
      assert.equal(loaded, 1)
      const select = container.querySelector<HTMLSelectElement>('select')
      assert.ok(select)
      assert.equal(select.value, configuredEngine || 'pydantic_ai')
      assert.equal(select.querySelector('option[value=""]'), null)
      assert.equal(select.querySelectorAll('option[value="pydantic_ai"]').length, 1)
      assert.equal(select.querySelector('option[value="pydantic_ai"]')?.textContent, 'Pydantic AI')
      assert.equal(Array.from(select.options).filter((option) => option.textContent?.includes('Pydantic AI')).length, 1)
      const save = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('保存') || button.textContent?.includes('Save'))
      assert.ok(save)
      await act(async () => save.click())
      assert.equal(saved, configuredEngine || 'pydantic_ai')
      assert.equal(changed, 1)
    } finally {
      engineApi.executionConfig = originalGet
      engineApi.setExecutionConfig = originalSave
      await act(async () => root.unmount())
      container.remove()
      await window.happyDOM.close()
    }
  })
}
