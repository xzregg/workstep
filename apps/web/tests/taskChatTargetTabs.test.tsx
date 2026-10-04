import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import TaskChatTargetTabs from '../src/components/TaskChatTargetTabs'

test('task composer target tabs expose step status and route a selection', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const selected: string[] = []
  try {
    await act(async () => root.render(<I18nProvider><TaskChatTargetTabs
      target="coordinator"
      steps={[{ key: 'build', label: 'Build', color: '#123456' }]}
      stepProgress={[{ step_key: 'build', status: 'failed', has_history: true }]}
      runningStepKeys={[]}
      resumableTarget={{ key: 'build', label: 'Build' }}
      onSelect={(key) => selected.push(key)}
    /></I18nProvider>))
    const coordinator = container.querySelector<HTMLButtonElement>('.step-target-tabs button')!
    const build = container.querySelector<HTMLButtonElement>('.task-chat-step-tab')!
    assert.equal(coordinator.getAttribute('aria-pressed'), 'true')
    assert.match(build.title, /Build/)
    await act(async () => build.click())
    assert.deepEqual(selected, ['build'])
    assert.ok(container.querySelector('.task-chat-target-hint'))
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
