import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { useTaskStore } from '../src/stores/taskStore'
import ArchiveExperienceDialog from '../src/components/ArchiveExperienceDialog'
import ArchiveExperienceProgress from '../src/components/ArchiveExperienceProgress'

test('failed generation retains process and output without archiving or writing Memory', async () => {
  const { window } = installDomEnvironment()
  const original = useTaskStore.getState()
  const mutations: string[] = []
  useTaskStore.setState({
    getArchiveExperienceDraft: async () => ({ found: false, message_id: null,
      experience: '', has_experience: false, events: [], prompt: '' }),
    prepareArchiveExperience: async (taskId, _projectId, messageId) => {
      useTaskStore.setState({ liveMessages: { [taskId]: { [messageId]: {
        id: messageId, channel: 'archive_experience', content: '金额统一使用分。',
        events: [], status: 'failed', proposals: [],
      } } } })
      throw new Error('草稿超过长度限制')
    },
    archiveTask: async () => { mutations.push('archive') },
    confirmArchiveExperience: async () => { mutations.push('confirm') },
  })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><ArchiveExperienceDialog
      task={{ id: 'task', title: '任务' }} projectId="project"
      onClose={() => {}} onArchived={() => { mutations.push('archived') }} /></I18nProvider>))
    const generate = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => /提炼错误经验|lesson/i.test(button.textContent || ''))!
    assert.ok(generate)
    await act(async () => generate.click())
    assert.match(container.textContent || '', /金额统一使用分/)
    const message = Object.values(useTaskStore.getState().liveMessages.task)[0]
    const idButton = container.querySelector<HTMLButtonElement>(`button[title="${message.id}"]`)
    assert.ok(idButton, 'failed archive process exposes its message ID')
    await act(async () => idButton.click())
    assert.match(container.textContent || '', new RegExp(message.id))
    assert.match(container.querySelector('[role="alert"]')?.textContent || '', /草稿超过长度限制/)
    assert.deepEqual(mutations, [])
    assert.ok([...container.querySelectorAll('button')]
      .some(button => /重新整理|Try again/i.test(button.textContent || '')))
  } finally {
    await act(async () => root.unmount())
    useTaskStore.setState(original)
    container.remove()
    await window.happyDOM.close()
  }
})

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
    assert.equal(dialog.querySelector<HTMLInputElement>('input[type=checkbox]')?.checked, true)
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => /Archive directly|直接归档/.test(button.textContent || '') && !button.disabled)!
    await act(async () => confirm.click())
    assert.deepEqual(calls[1], ['confirm', 'task', 'project', '', true])
    assert.equal(archived, 1)
  } finally {
    await act(async () => root.unmount())
    useTaskStore.setState({ getArchiveExperienceDraft: original.getArchiveExperienceDraft,
      confirmArchiveExperience: original.confirmArchiveExperience })
    container.remove()
    await window.happyDOM.close()
  }
})


test('archive message ID is available before the first live event', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><ArchiveExperienceProgress
      messageId="pending-archive-message" projectId="project" running
      agentName="协调助手" thinkingLabel="对错误记录" /></I18nProvider>))
    const button = container.querySelector<HTMLButtonElement>('button[title="pending-archive-message"]')
    assert.ok(button)
    await act(async () => button.click())
    assert.match(container.textContent || '', /pending-archive-message/)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
