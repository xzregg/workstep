import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { taskApi } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import { useTaskStore } from '../src/stores/taskStore'
import { useTaskStepControls } from '../src/hooks/useTaskStepControls'

test('step controls stop, restart and retry through their task APIs', async () => {
  const { window } = installDomEnvironment()
  const originals = { cancel: taskApi.cancelStep, restart: taskApi.restartStepWithFreshSession,
    retry: taskApi.retryFailedMessage, history: taskApi.history,
    refresh: useTaskStore.getState().refreshTask }
  const calls: unknown[][] = []
  taskApi.cancelStep = async (...args) => { calls.push(['cancel', ...args]); return {} as Awaited<ReturnType<typeof taskApi.cancelStep>> }
  taskApi.restartStepWithFreshSession = async (...args) => { calls.push(['restart', ...args]); return {} as Awaited<ReturnType<typeof taskApi.restartStepWithFreshSession>> }
  taskApi.retryFailedMessage = async (...args) => { calls.push(['retry', ...args]); return {} as Awaited<ReturnType<typeof taskApi.retryFailedMessage>> }
  taskApi.history = async (...args) => { calls.push(['history', ...args]); return { messages: [{ id: 'message' }] } as Awaited<ReturnType<typeof taskApi.history>> }
  useTaskStore.setState({ refreshTask: async (...args) => { calls.push(['refresh', ...args]); return {} as Awaited<ReturnType<typeof originals.refresh>> } })
  const refreshed: unknown[][] = []
  const errors: string[] = []
  let followCount = 0
  let current: ReturnType<typeof useTaskStepControls>
  function Harness() {
    current = useTaskStepControls({ taskId: 'task', projectId: 'project',
      onHistoryRefresh: (messages) => refreshed.push(messages),
      onError: (message) => errors.push(message), onFollow: () => { followCount++ } })
    return null
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    await act(async () => current.stopStep('build'))
    await act(async () => current.restartStepWithFreshSession('build'))
    await act(async () => current.retryFailedMessage('message'))
    assert.deepEqual(calls.map((call) => call[0]), ['cancel', 'restart', 'refresh', 'retry', 'refresh', 'history'])
    assert.deepEqual(calls[0], ['cancel', 'task', 'build', 'project'])
    assert.deepEqual(refreshed, [[{ id: 'message' }]])
    assert.equal(followCount, 2)
    assert.deepEqual(errors, ['', '', ''])
  } finally {
    await act(async () => root.unmount())
    taskApi.cancelStep = originals.cancel
    taskApi.restartStepWithFreshSession = originals.restart
    taskApi.retryFailedMessage = originals.retry
    taskApi.history = originals.history
    useTaskStore.setState({ refreshTask: originals.refresh })
    container.remove()
    await window.happyDOM.close()
  }
})
