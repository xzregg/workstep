import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import AiTaskCreateChat from '../src/components/AiTaskCreateChat'
import { assistantApi, providerApi, taskDraftApi } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import { useTaskDraftStore } from '../src/stores/taskDraftStore'

test('dynamic schedule preview renders every draft and its own start time', async () => {
  const { window } = installDomEnvironment()
  const original = { list: assistantApi.list, providers: providerApi.list, chat: taskDraftApi.chat }
  const previous = useTaskDraftStore.getState()
  let sessionId = ''
  assistantApi.list = async () => ({ assistants: [] })
  providerApi.list = async () => ({ providers: [] })
  taskDraftApi.chat = async (_project, _content, sid) => {
    sessionId = sid!
    return { session_id: sid!, turn_id: 'turn', assistant_message_id: 'reply', status: 'running' }
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const drafts = [1, 2, 3, 4, 5].map(i => ({ title: `批量任务${i}`, description: `内容${i}`, scheduled_start_at: `2099-01-0${i}T09:00:00+08:00` }))
  try {
    await act(async () => root.render(<I18nProvider><AiTaskCreateChat projectId="project" taskTitle="" taskDescription=""
      initialMessage="生成5个任务" autoSend candidateWorkflowIds={[]} onDraft={() => {}} /></I18nProvider>))
    assert.ok(sessionId)
    await act(async () => useTaskDraftStore.getState().handleWsEvent({
      type: 'CUSTOM', name: 'workstep.task_draft', channel: 'task_create', session_id: sessionId,
      value: { ...drafts[0], task_drafts: drafts },
    }))
    assert.equal(container.querySelectorAll('.task-draft-preview').length, 5)
    assert.deepEqual([...container.querySelectorAll('.task-draft-preview time')].map(node => node.getAttribute('datetime')), drafts.map(draft => draft.scheduled_start_at))
    for (const draft of drafts) assert.ok(container.textContent!.includes(draft.title))
    await act(async () => useTaskDraftStore.setState(state => ({ sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], running: false } } })))
  } finally {
    await act(async () => root.unmount())
    assistantApi.list = original.list; providerApi.list = original.providers; taskDraftApi.chat = original.chat
    useTaskDraftStore.setState(previous)
    container.remove(); await window.happyDOM.close()
  }
})
