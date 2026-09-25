import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import TaskReviewConfigPanel from '../src/components/TaskReviewConfigPanel'
import { useTaskStore } from '../src/stores/taskStore'

test('review settings own their draft and save the selected step without dropping other overrides', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const original = useTaskStore.getState().updateTaskDescription
  const calls: unknown[][] = []
  useTaskStore.setState({ updateTaskDescription: async (...args) => {
    calls.push(args)
    return {} as never
  } })
  try {
    await act(async () => root.render(<I18nProvider><TaskReviewConfigPanel
      taskId="task-1" stepKey="build" projectId="project-1"
      reviewOverrides={{ build: { mode: 'skip', prompt: 'old' }, test: { mode: 'manual' } }}
    /></I18nProvider>))
    const toggle = container.querySelector<HTMLButtonElement>('.task-review-config-toggle')!
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    await act(async () => toggle.click())
    const auto = [...container.querySelectorAll<HTMLButtonElement>('.task-review-config-mode')][1]
    await act(async () => auto.click())
    assert.equal(auto.getAttribute('aria-pressed'), 'true')
    const retry = container.querySelector<HTMLInputElement>('.task-review-config-retry-input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(retry, '9')
      retry.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => container.querySelector<HTMLButtonElement>('.task-review-config-save')!.click())
    assert.deepEqual(calls, [[
      'task-1', undefined, 'project-1',
      { build: { mode: 'auto', auto: true, maxRetries: 5, prompt: 'old' }, test: { mode: 'manual' } },
    ]])
  } finally {
    await act(async () => root.unmount())
    useTaskStore.setState({ updateTaskDescription: original })
    container.remove()
    await window.happyDOM.close()
  }
})

test('review settings expose save failures and allow retry', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const original = useTaskStore.getState().updateTaskDescription
  let calls = 0
  useTaskStore.setState({ updateTaskDescription: async () => {
    if (++calls === 1) throw new Error('offline')
    return {} as never
  } })
  try {
    await act(async () => root.render(<I18nProvider><TaskReviewConfigPanel
      taskId="task-1" stepKey="build" projectId="project-1" reviewOverrides={null}
    /></I18nProvider>))
    await act(async () => container.querySelector<HTMLButtonElement>('.task-review-config-toggle')!.click())
    const save = container.querySelector<HTMLButtonElement>('.task-review-config-save')!
    await act(async () => save.click())
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /offline/)
    await act(async () => save.click())
    assert.equal(calls, 2)
    assert.equal(container.querySelector('[role="alert"]'), null)
  } finally {
    await act(async () => root.unmount())
    useTaskStore.setState({ updateTaskDescription: original })
    container.remove()
    await window.happyDOM.close()
  }
})
