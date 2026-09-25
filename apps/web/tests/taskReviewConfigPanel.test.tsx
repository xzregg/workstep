import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import TaskReviewConfigPanel from '../src/components/TaskReviewConfigPanel'

test('review settings disclose locally and clamp automatic retries before saving', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let mode = 'skip', retries = 1, saves = 0
  const render = () => <I18nProvider><TaskReviewConfigPanel mode={mode}
    onModeChange={(value) => { mode = value; root.render(render()) }}
    retries={retries} onRetriesChange={(value) => { retries = value; root.render(render()) }}
    onSave={() => { saves++ }} /></I18nProvider>
  try {
    await act(async () => root.render(render()))
    const toggle = container.querySelector<HTMLButtonElement>('.task-review-config-toggle')!
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    await act(async () => toggle.click())
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    const auto = [...container.querySelectorAll<HTMLButtonElement>('.task-review-config-mode')][1]
    await act(async () => auto.click())
    assert.equal(mode, 'auto')
    assert.equal(auto.getAttribute('aria-pressed'), 'true')
    const retry = container.querySelector<HTMLInputElement>('.task-review-config-retry-input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(retry, '9')
      retry.dispatchEvent(new Event('input', { bubbles: true }))
    })
    assert.equal(retries, 5)
    await act(async () => container.querySelector<HTMLButtonElement>('.task-review-config-save')!.click())
    assert.equal(saves, 1)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
