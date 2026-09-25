import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import type { TaskArtifact } from '../src/api/client'
import TaskStepIoPanel from '../src/components/TaskStepIoPanel'
import type { StepData } from '../src/components/TaskDetailView'

test('step IO shows rounds and opens only available input artifacts', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const step: StepData = { key: 'build', label: '构建', color: '#2468ab', prompt: '',
    inputs: [{ name: 'source', type: 'file' }], outputs: [] }
  const artifact = { name: 'source', step_key: 'prepare', round: 1, path: 'source.txt' } as TaskArtifact
  const calls: unknown[][] = []
  const render = (artifacts: TaskArtifact[]) => <I18nProvider><TaskStepIoPanel
    currentStep={step} steps={[step]} workflowConnections={[]} artifacts={artifacts}
    artifactInputSnapshots={[]} canChat={false} locale="zh-CN"
    onOpenArtifact={(...args) => calls.push(args)} /></I18nProvider>
  try {
    await act(async () => root.render(render([])))
    assert.equal(container.querySelector('.task-step-io-input')?.getAttribute('role'), null)
    await act(async () => root.render(render([artifact])))
    const input = container.querySelector<HTMLElement>('.task-step-io-input')!
    assert.equal(input.getAttribute('role'), 'button')
    await act(async () => input.click())
    assert.deepEqual(calls[0], ['source', 'prepare', 1, 'source.txt'])
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
