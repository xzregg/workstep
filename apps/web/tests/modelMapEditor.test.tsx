// Must stay first: react-dom snapshots DOM support during module evaluation.
import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ModelMapEditor from '../src/components/ModelMapEditor'
import { I18nProvider } from '../src/i18n'

async function renderEditor(value: string, onChange: (value: string) => void) {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <I18nProvider>
        <ModelMapEditor value={value} onChange={onChange} />
      </I18nProvider>,
    )
  })
  return { container, root }
}

async function change(window: ReturnType<typeof installDomEnvironment>['window'], input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('model map editor renders normalized values and emits edited JSON', async () => {
  const { window } = installDomEnvironment()
  const changes: string[] = []
  const { container, root } = await renderEditor(JSON.stringify({
    sonnet: { model: 'qwen3-max', name: 'Qwen Max' },
  }), (value) => changes.push(value))
  try {
    const model = container.querySelector('[data-alias="sonnet"] [data-field="model"]') as HTMLInputElement
    const name = container.querySelector('[data-alias="sonnet"] [data-field="name"]') as HTMLInputElement
    assert.equal(model.value, 'qwen3-max')
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
    const model = container.querySelector('[data-alias="sonnet"] [data-field="model"]') as HTMLInputElement
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
    const model = container.querySelector('[data-alias="sonnet"] [data-field="model"]') as HTMLInputElement
    assert.equal(model.value, '')
    assert.equal(model.disabled, true)
    assert.deepEqual(changes, [])
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
