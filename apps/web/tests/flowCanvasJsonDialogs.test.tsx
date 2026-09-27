import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import FlowCanvasJsonDialogs from '../src/components/FlowCanvasJsonDialogs'

test('JSON import rejects a non-object and applies valid canvas data', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let imported: unknown = null
  let closed = 0
  try {
    await act(async () => root.render(<I18nProvider><FlowCanvasJsonDialogs
      exportOpen={false} importOpen onCloseExport={() => {}} onCloseImport={() => { closed += 1 }}
      getSteps={() => ({ nodes: [], connections: [] })} onImport={(steps) => { imported = steps }}
      onFeedback={() => {}}
    /></I18nProvider>))
    const editor = container.querySelector<HTMLTextAreaElement>('textarea')
    assert.ok(editor)
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    assert.ok(setter)
    const submit = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('确认导入') || button.textContent?.includes('Confirm import'))
    assert.ok(submit)
    assert.equal(submit.disabled, true)
    await act(async () => { setter.call(editor, '[]'); editor.dispatchEvent(new window.Event('input', { bubbles: true })) })
    await act(async () => submit.click())
    assert.equal(imported, null)
    assert.ok(container.textContent?.includes('JSON'))
    const steps = { nodes: [{ id: 1, type: 'build' }], connections: [] }
    await act(async () => { setter.call(editor, JSON.stringify(steps)); editor.dispatchEvent(new window.Event('input', { bubbles: true })) })
    await act(async () => submit.click())
    assert.deepEqual(imported, steps)
    assert.equal(closed, 1)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
