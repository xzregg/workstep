import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { useTaskStore } from '../src/stores/taskStore'
import ArchiveExperienceDialog from '../src/components/ArchiveExperienceDialog'

test('an empty saved archive draft can be archived without adding experience', async () => {
  const { window } = installDomEnvironment()
  const original = useTaskStore.getState()
  const calls: unknown[][] = []
  useTaskStore.setState({
    getArchiveExperienceDraft: async (...args) => {
      calls.push(['load', ...args])
      return { found: true, message_id: 'message', experience: '', has_experience: false,
        events: [], prompt: '' }
    },
    confirmArchiveExperience: async (...args) => { calls.push(['confirm', ...args]) },
  })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let archived = 0
  try {
    await act(async () => root.render(<I18nProvider><ArchiveExperienceDialog
      task={{ id: 'task', title: '任务' }} projectId="project"
      onClose={() => {}} onArchived={() => { archived++ }} /></I18nProvider>))
    assert.deepEqual(calls[0], ['load', 'task', 'project'])
    const dialog = container.querySelector('[role="dialog"]')!
    assert.ok(dialog.textContent?.length)
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => /Archive directly|直接归档/.test(button.textContent || '') && !button.disabled)!
    await act(async () => confirm.click())
    assert.deepEqual(calls[1], ['confirm', 'task', 'project', ''])
    assert.equal(archived, 1)
  } finally {
    await act(async () => root.unmount())
    useTaskStore.setState({ getArchiveExperienceDraft: original.getArchiveExperienceDraft,
      confirmArchiveExperience: original.confirmArchiveExperience })
    container.remove()
    await window.happyDOM.close()
  }
})
