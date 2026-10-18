import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import CoordinatorConfigBar from '../src/components/CoordinatorConfigBar'
import { I18nProvider } from '../src/i18n'
import { engineApi, fetchEngineModels, invalidateEngineModels, type CoordinatorEngineSummary, type EngineConfigField } from '../src/api/client'

function installDom() {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    DOMRect: window.DOMRect,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    matchMedia: window.matchMedia.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  return window
}

test('selectors keep all engine-declared efforts selectable regardless of model catalog', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const original = engineApi.models
  try {
    for (const [engine, efforts] of [
      ['codex_sdk', ['low', 'medium', 'high', 'xhigh', 'max']],
      ['codex', ['none', 'minimal', 'low', 'high']],
      ['example_custom', ['high', 'minimal', 'low']],
    ] as const) {
      let selected = ''
      invalidateEngineModels(engine)
      engineApi.models = async () => ({
        engine_id: engine, models: [{ id: 'native', label: 'Native', description: null,
          supported_reasoning_efforts: [...efforts], is_default: true }],
        default_model: 'native', error: null,
      })
      await fetchEngineModels(engine)
      const declared = engine === 'example_custom' ? [...efforts, 'ultra']
        : ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
      const field: EngineConfigField = {
        key: 'model_reasoning_effort', label: '推理强度', type: 'select',
        model_capability: 'supported_reasoning_efforts',
        options: declared.map(value => ({ value, label: value })),
        default: '', placeholder: '', help: '', required: false, sensitive: false, confirm_values: [],
      }
      await act(async () => {
        root.render(
          <I18nProvider>
            <CoordinatorConfigBar
              engines={[{ id: engine, config: { fields: [field], values: {}, secrets: {}, step_fields: [] } } as CoordinatorEngineSummary]}
              engine="" defaultEngine={engine} model="native" fastModel=""
              thinkingEffort="" defaultThinkingEffort="low"
              onEngineChange={() => {}} onModelChange={() => {}} onFastModelChange={() => {}}
              onThinkingEffortChange={(value) => { selected = value }}
            />
          </I18nProvider>,
        )
      })
      const select = Array.from(container.querySelectorAll('select')).find(
        element => Array.from(element.options).some(option => option.value === 'ultra'),
      )!
      assert.ok(select)
      assert.deepEqual(Array.from(select.options).map(option => option.value), ['', ...declared])
      assert.match(select.options[0].textContent || '', /默认（低）/)
      assert.ok(Array.from(select.options).every(option => !option.disabled))
      await act(async () => {
        select.value = efforts[0]
        select.dispatchEvent(new window.Event('change', { bubbles: true }))
      })
      assert.equal(selected, efforts[0])
      invalidateEngineModels(engine)
    }
  } finally {
    engineApi.models = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('empty thinking effort shows the inherited default level', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <CoordinatorConfigBar
            engines={[]}
            engine=""
            defaultEngine="codex_sdk"
            model=""
            fastModel=""
            thinkingEffort=""
            defaultThinkingEffort="low"
            onEngineChange={() => {}}
            onModelChange={() => {}}
            onFastModelChange={() => {}}
            onThinkingEffortChange={() => {}}
          />
        </I18nProvider>,
      )
    })

    assert.match(container.textContent || '', /默认（低）/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('auto thinking effort shows the inherited automatic level', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <CoordinatorConfigBar
            engines={[]}
            engine=""
            defaultEngine="codex_sdk"
            model=""
            fastModel=""
            thinkingEffort=""
            defaultThinkingEffort="auto"
            onEngineChange={() => {}}
            onModelChange={() => {}}
            onFastModelChange={() => {}}
            onThinkingEffortChange={() => {}}
          />
        </I18nProvider>,
      )
    })

    assert.match(container.textContent || '', /默认（自动）/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
