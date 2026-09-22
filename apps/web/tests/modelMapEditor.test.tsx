// Must stay first: react-dom snapshots DOM support during module evaluation.
import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ModelMapEditor from '../src/components/ModelMapEditor'
import { I18nProvider } from '../src/i18n'

const modelOptions = [
  { id: 'qwen3-max', label: 'Qwen 3 Max', description: null },
  { id: 'qwen3.8-max', label: 'Qwen 3.8 Max', description: null },
]

async function renderEditor(
  value: string,
  onChange: (value: string) => void,
  onRefresh = () => {},
) {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <I18nProvider>
        <ModelMapEditor
          value={value}
          modelOptions={modelOptions}
          onChange={onChange}
          onRefresh={onRefresh}
        />
      </I18nProvider>,
    )
  })
  return { container, root }
}

async function change(window: ReturnType<typeof installDomEnvironment>['window'], input: HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      'value',
    )?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

test('model map editor renders normalized values and emits edited JSON', async () => {
  const { window } = installDomEnvironment()
  const changes: string[] = []
  const { container, root } = await renderEditor(JSON.stringify({
    sonnet: { model: 'qwen3-max', name: 'Qwen Max' },
  }), (value) => changes.push(value))
  try {
    const model = container.querySelector('[data-alias="sonnet"] [data-field="model"]') as HTMLSelectElement
    const name = container.querySelector('[data-alias="sonnet"] [data-field="name"]') as HTMLInputElement
    assert.equal(model.value, 'qwen3-max')
    assert.deepEqual([...model.options].map((option) => option.value), ['', 'qwen3-max', 'qwen3.8-max'])
    assert.equal(name.value, 'Qwen Max')
    assert.equal(container.querySelector('.field-hint'), null)

    await change(window, model, 'qwen3.8-max')

    assert.deepEqual(JSON.parse(changes.at(-1) || '{}'), {
      sonnet: { model: 'qwen3.8-max', name: 'Qwen Max' },
    })
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('model map editor emits an empty string after clearing the last model', async () => {
  const { window } = installDomEnvironment()
  const changes: string[] = []
  const { container, root } = await renderEditor(JSON.stringify({
    sonnet: { model: 'qwen3-max', name: 'qwen3-max' },
  }), (value) => changes.push(value))
  try {
    const model = container.querySelector('[data-alias="sonnet"] [data-field="model"]') as HTMLSelectElement
    await change(window, model, '')
    assert.equal(changes.at(-1), '')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('model map editor preserves invalid JSON instead of emitting replacement data', async () => {
  const { window } = installDomEnvironment()
  const changes: string[] = []
  const { container, root } = await renderEditor('{bad json', (value) => changes.push(value))
  try {
    assert.ok(container.querySelector('[role="alert"]')?.textContent?.trim())
    const model = container.querySelector('[data-alias="sonnet"] [data-field="model"]') as HTMLSelectElement
    assert.equal(model.value, '')
    assert.equal(model.disabled, true)
    assert.deepEqual(changes, [])
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('model map editor refreshes the shared model list only on explicit click', async () => {
  const { window } = installDomEnvironment()
  let refreshes = 0
  const { container, root } = await renderEditor('', () => {}, () => { refreshes += 1 })
  try {
    assert.equal(refreshes, 0)
    const refresh = container.querySelector('[data-model-map-refresh]') as HTMLButtonElement
    await act(async () => refresh.click())
    assert.equal(refreshes, 1)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
