import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { workflowGenApi, taskDraftApi } from '../src/api/client'
import AiFlowChat from '../src/components/AiFlowChat'
import AiTaskCreateChat from '../src/components/AiTaskCreateChat'
import { useWorkflowGenStore } from '../src/stores/workflowGenStore'
import { useTaskDraftStore } from '../src/stores/taskDraftStore'

for (const kind of ['flow', 'task'] as const) {
  test(`${kind} confirms the user id through HTTP when its WebSocket acknowledgement is missed`, async () => {
    const { window } = installDomEnvironment()
    const originalFetch = globalThis.fetch
    const api = kind === 'flow' ? workflowGenApi : taskDraftApi
    const originalChat = api.chat
    const store = kind === 'flow' ? useWorkflowGenStore : useTaskDraftStore
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    let sentSession = ''
    try {
      useLocaleStore.setState({ locale: 'zh-CN' })
      store.setState({ sessions: {} })
      globalThis.fetch = (async () => new Response(JSON.stringify({
        assistants: [], providers: [], skills: [], items: [],
      }), { headers: { 'Content-Type': 'application/json' } })) as never
      api.chat = (async (_project, _content, session) => {
        sentSession = session!
        return { session_id: sentSession, turn_id: 'saved-user', assistant_message_id: 'reply', status: 'queued' }
      }) as never
      await act(async () => root.render(<I18nProvider>{kind === 'flow'
        ? <AiFlowChat projectId="p" initialMessage="要求" />
        : <AiTaskCreateChat projectId="p" taskTitle="任务" taskDescription="" initialMessage="要求" onDraft={() => {}} />
      }</I18nProvider>))
      const send = document.querySelector<HTMLButtonElement>('.chat-input-send')
      assert.ok(send)
      assert.equal(send.disabled, false)
      await act(async () => send.click())
      assert.ok(sentSession)
      assert.deepEqual(store.getState().sessions[sentSession].messages.map((message) => message.id), ['saved-user', 'reply'])
      assert.equal(store.getState().sessions[sentSession].running, true)
      assert.match(document.body.textContent || '', /处理中.*秒/)
      // History/live can arrive after HTTP; they must update that same bubble.
      await act(async () => store.getState().handleWsEvent({
        type: 'TEXT_MESSAGE_START', channel: kind === 'flow' ? 'flow_gen' : 'task_create',
        session_id: sentSession, messageId: 'saved-user', role: 'user', content: '要求',
      }))
      assert.equal(store.getState().sessions[sentSession].messages.length, 2)
    } finally {
      await act(async () => root.unmount())
      api.chat = originalChat
      globalThis.fetch = originalFetch
      store.setState({ sessions: {} })
      await window.happyDOM.close()
    }
  })
}
