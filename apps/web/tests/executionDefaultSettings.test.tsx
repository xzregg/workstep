import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { engineApi, type EngineInfo } from '../src/api/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
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
      assert.equal(container.querySelector('select'), null, 'default selection is only editable in the dialog')
      const edit = container.querySelector<HTMLButtonElement>('.execution-default-settings-edit')!
      assert.ok(edit)
      await act(async () => edit.click())
      const select = container.querySelector<HTMLSelectElement>('[role="dialog"] select')
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
      assert.equal(container.querySelector('[role="dialog"]'), null, 'successful save closes the editor')
    } finally {
      engineApi.executionConfig = originalGet
      engineApi.setExecutionConfig = originalSave
      await act(async () => root.unmount())
      container.remove()
      await window.happyDOM.close()
    }
  })
}


test('default engine dialog preserves drafts, handles save failures and only publishes a successful save', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originals = { executionConfig: engineApi.executionConfig, setExecutionConfig: engineApi.setExecutionConfig }
  let changed = 0
  let calls = 0
  let finish!: (value: { engine: string }) => void
  engineApi.executionConfig = async () => ({ engine: 'codex' })
  engineApi.setExecutionConfig = async () => { calls += 1; if (calls === 1) throw new Error('保存失败，请重试'); return new Promise(resolve => { finish = resolve }) }
  useLocaleStore.getState().setLocale('zh-CN')
  const click = async (text: string, last = false) => {
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(b => b.textContent === text)
    const button = last ? buttons.at(-1) : buttons[0]
    assert.ok(button, text)
    await act(async () => button.click())
  }
  const choose = async (value: string) => {
    const select = container.querySelector<HTMLSelectElement>('select')!
    await act(async () => { select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true })) })
  }
  try {
    await act(async () => root.render(<I18nProvider><ExecutionDefaultSettings loading={false}
      onChanged={() => { changed += 1 }} engines={[
        { id: 'codex', installed: true, configured: true, verified: true, mode: 'cli' },
        { id: 'pydantic_ai', installed: true, configured: true, verified: true, built_in: true, mode: 'agent' },
      ] as EngineInfo[]} /></I18nProvider>))
    await click('编辑')
    await choose('pydantic_ai')
    assert.match(container.querySelector('.execution-default-settings-current')!.textContent!, /Codex/)
    await click('取消')
    assert.equal(container.querySelectorAll('[role="dialog"]').length, 2)
    await click('取消', true)
    assert.equal(container.querySelector<HTMLSelectElement>('select')!.value, 'pydantic_ai')
    await click('取消')
    await click('放弃')
    assert.equal(container.querySelector('[role="dialog"]'), null)
    assert.equal(calls, 0)
    await click('编辑')
    assert.equal(container.querySelector<HTMLSelectElement>('select')!.value, 'codex')
    await choose('pydantic_ai')
    await click('保存默认值')
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /保存失败/)
    assert.equal(changed, 0)
    assert.equal(container.querySelector<HTMLSelectElement>('select')!.value, 'pydantic_ai')
    await click('保存默认值')
    await click('取消')
    assert.equal(container.querySelectorAll('[role="dialog"]').length, 1, 'saving cannot close the dialog')
    await act(async () => finish({ engine: 'pydantic_ai' }))
    assert.equal(container.querySelector('[role="dialog"]'), null)
    assert.match(container.querySelector('.execution-default-settings-current')!.textContent!, /Pydantic AI/)
    assert.equal(changed, 1)
  } finally {
    Object.assign(engineApi, originals)
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
