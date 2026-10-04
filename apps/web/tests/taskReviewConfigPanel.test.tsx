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

for (const scenario of [
  { name: 'inherits explicit workflow auto even when legacy auto is false',
    workflowReview: { mode: 'auto', auto: false, maxRetries: 3, prompt: '流程审核要求' },
    overrides: null, expected: 'auto', retries: 3 },
  { name: 'inherits legacy workflow auto', workflowReview: { auto: true },
    overrides: null, expected: 'auto', retries: 1 },
  { name: 'task manual overrides workflow auto',
    workflowReview: { mode: 'auto', auto: true, maxRetries: 3 },
    overrides: { build: { mode: 'manual' } }, expected: 'manual', retries: 3 },
  { name: 'partial task override keeps workflow mode',
    workflowReview: { mode: 'auto', maxRetries: 3 },
    overrides: { build: { prompt: '任务审核要求' } }, expected: 'auto', retries: 3 },
  { name: 'workflow without review skips review',
    workflowReview: null, overrides: null, expected: 'skip', retries: 1 },
] as const) {
  test(`review settings ${scenario.name} and persist a manual override`, async () => {
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
        workflowReview={scenario.workflowReview} reviewOverrides={scenario.overrides}
      /></I18nProvider>))
      await act(async () => container.querySelector<HTMLButtonElement>('.task-review-config-toggle')!.click())
      const modes = [...container.querySelectorAll<HTMLButtonElement>('.task-review-config-mode')]
      assert.equal(modes[['skip', 'auto', 'manual'].indexOf(scenario.expected)].getAttribute('aria-pressed'), 'true')
      await act(async () => modes[2].click())
      await act(async () => container.querySelector<HTMLButtonElement>('.task-review-config-save')!.click())
      assert.deepEqual(calls, [['task-1', undefined, 'project-1', { build: {
        mode: 'manual', auto: false, maxRetries: scenario.retries,
        prompt: scenario.overrides?.build?.prompt ?? scenario.workflowReview?.prompt ?? '',
      } }]])
    } finally {
      await act(async () => root.unmount())
      useTaskStore.setState({ updateTaskDescription: original })
      container.remove()
      await window.happyDOM.close()
    }
  })
}
