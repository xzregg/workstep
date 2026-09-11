import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { engineApi, type EngineConfigPayload } from '../src/api/client'
import EngineConfigForm, { type EngineConfigFormHandle } from '../src/components/EngineConfigForm'
import { I18nProvider } from '../src/i18n'

function installDom() {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  return window
}

test('engine config form renders a full-width model map and submits its JSON value', async () => {
  const window = installDom()
  const original = engineApi.saveConfig
  const initial = JSON.stringify({ sonnet: { model: 'qwen3-max', name: 'Qwen Max' } })
  let submitted = ''
  const config: EngineConfigPayload = {
    fields: [{
      key: 'model_map',
      label: '模型映射',
      type: 'model_map',
      placeholder: '',
      options: null,
      required: false,
      help: '',
      default: '',
      sensitive: false,
      confirm_values: [],
      stage_hidden: true,
    }],
    stage_fields: [],
    values: { model_map: initial },
    secrets: {},
  }
  engineApi.saveConfig = async (_engineId, input) => {
    submitted = input.values.model_map
    return {
      engine_id: 'claude',
      fields: config.fields,
      values: config.values,
      secrets: {},
      configured: true,
      installed: true,
      saved: true,
      engine: {} as never,
    }
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const ref = createRef<EngineConfigFormHandle>()
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <EngineConfigForm ref={ref} engineId="claude" config={config} />
        </I18nProvider>,
      )
    })
    const editor = container.querySelector('[data-model-map-editor]') as HTMLElement
    assert.ok(editor)
    assert.equal(editor.parentElement?.style.gridColumn, '1 / -1')

    await act(async () => { ref.current?.save(); await Promise.resolve() })
    assert.deepEqual(JSON.parse(submitted), JSON.parse(initial))
  } finally {
    engineApi.saveConfig = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
