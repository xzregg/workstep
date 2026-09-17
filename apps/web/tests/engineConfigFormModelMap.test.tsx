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
          <EngineConfigForm
            ref={ref}
            engineId="claude"
            config={config}
            modelOptions={[
              { id: 'qwen3-max', label: 'Qwen 3 Max', description: null },
            ]}
            onRefreshModelOptions={() => {}}
          />
        </I18nProvider>,
      )
    })
    const editor = container.querySelector('[data-model-map-editor]') as HTMLElement
    assert.ok(editor)
    assert.equal(editor.parentElement?.style.gridColumn, '1 / -1')
    assert.equal(
      (editor.querySelector('[data-field="model"]') as HTMLSelectElement).options[1]?.value,
      'qwen3-max',
    )

    await act(async () => { ref.current?.save(); await Promise.resolve() })
    assert.deepEqual(JSON.parse(submitted), JSON.parse(initial))
  } finally {
    engineApi.saveConfig = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('engine config form flags invalid JSON fields and blocks saving them', async () => {
  const window = installDom()
  const original = engineApi.saveConfig
  const baseField = {
    key: 'custom_settings',
    label: '自定义配置 (JSON)',
    type: 'json',
    placeholder: '',
    options: null,
    required: false,
    help: '',
    default: '',
    sensitive: false,
    confirm_values: [],
    stage_hidden: true,
  } as const
  let saveCalls = 0
  engineApi.saveConfig = async () => {
    saveCalls += 1
    return {
      engine_id: 'claude',
      fields: [] as never,
      values: {},
      secrets: {},
      configured: true,
      installed: true,
      saved: true,
      engine: {} as never,
    }
  }

  const renderWith = async (value: string) => {
    const config: EngineConfigPayload = {
      fields: [baseField],
      stage_fields: [],
      values: { custom_settings: value },
      secrets: {},
    }
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    const ref = createRef<EngineConfigFormHandle>()
    await act(async () => {
      root.render(
        <I18nProvider>
          <EngineConfigForm ref={ref} engineId="claude" config={config} />
        </I18nProvider>,
      )
    })
    return { container, root, ref }
  }

  try {
    const invalid = await renderWith('{not json')
    try {
      const textarea = invalid.container.querySelector('textarea') as HTMLTextAreaElement
      assert.equal(textarea.getAttribute('aria-invalid'), 'true')
      assert.equal(
        invalid.container.querySelector('[role="alert"]')?.textContent,
        '自定义配置必须是合法 JSON',
      )
      await act(async () => { invalid.ref.current?.save(); await Promise.resolve() })
      assert.equal(saveCalls, 0, 'invalid JSON must not be saved')
    } finally {
      await act(async () => invalid.root.unmount())
      invalid.container.remove()
    }

    const notObject = await renderWith('[]')
    try {
      assert.equal(
        notObject.container.querySelector('[role="alert"]')?.textContent,
        '自定义配置必须是 JSON 对象',
      )
    } finally {
      await act(async () => notObject.root.unmount())
      notObject.container.remove()
    }

    const valid = await renderWith('{"env": {"FOO": "bar"}}')
    try {
      const textarea = valid.container.querySelector('textarea') as HTMLTextAreaElement
      assert.equal(textarea.getAttribute('aria-invalid'), 'false')
      assert.equal(valid.container.querySelector('[role="alert"]'), null)
      await act(async () => { valid.ref.current?.save(); await Promise.resolve() })
      assert.equal(saveCalls, 1)
    } finally {
      await act(async () => valid.root.unmount())
      valid.container.remove()
    }
  } finally {
    engineApi.saveConfig = original
    await window.happyDOM.close()
  }
})
