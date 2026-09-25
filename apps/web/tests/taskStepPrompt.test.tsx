import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import TaskStepPrompt from '../src/components/TaskStepPrompt'

test('step prompt displays markdown and opens editing only when enabled', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let opens = 0
  try {
    await act(async () => root.render(<I18nProvider><TaskStepPrompt
      label="Build" color="#123456" prompt="**Build the app**" projectId="project-1"
      onEdit={() => { opens++ }}
    /></I18nProvider>))
    assert.match(container.textContent ?? '', /Build the app/)
    assert.equal(container.querySelector('.task-step-prompt')?.getAttribute('style'), '--task-step-prompt-color: #123456;')
    await act(async () => container.querySelector<HTMLButtonElement>('.task-step-prompt-edit')!.click())
    assert.equal(opens, 1)

    await act(async () => root.render(<I18nProvider><TaskStepPrompt
      label="Build" color="#123456" prompt="" projectId="project-1"
    /></I18nProvider>))
    assert.equal(container.querySelector('.task-step-prompt-edit'), null)
    assert.ok(container.querySelector('.task-step-prompt-empty'))
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
