import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ChatMessageBubble from '../src/components/ChatMessageBubble'
import ChatInput from '../src/components/ChatInput'
import { I18nProvider } from '../src/i18n'
import { createAssistantStore } from '../src/stores/assistantStore'
import { installDomEnvironment } from './helpers/domEnv'

test('goal lifecycle survives live events and history hydration', () => {
  const store = createAssistantStore({ channel: 'session_chat' })
  store.getState().newSession('goal-session')
  store.getState().handleWsEvent({
    type: 'TEXT_MESSAGE_START', channel: 'session_chat',
    session_id: 'goal-session', messageId: 'goal-message',
  })
  store.getState().handleWsEvent({
    type: 'CUSTOM', name: 'workstep.goal_update',
    value: { objective: '修复性能问题', status: 'active' },
    channel: 'session_chat', session_id: 'goal-session', messageId: 'goal-message',
  })
  store.getState().handleWsEvent({
    type: 'CUSTOM', name: 'workstep.goal_update',
    value: { objective: '修复性能问题', status: 'complete' },
    channel: 'session_chat', session_id: 'goal-session', messageId: 'goal-message',
  })
  const message = store.getState().sessions['goal-session'].messages[0]
  const restored = createAssistantStore({ channel: 'session_chat' })
  restored.getState().hydrateSession('goal-session', [message])
  assert.deepEqual(restored.getState().sessions['goal-session'].messages[0].events?.map(
    (event) => event.value?.status,
  ), ['active', 'complete'])
})

test('assistant message shows the native goal and its latest status', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  try {
    await act(async () => root.render(
      <I18nProvider>
        <ChatMessageBubble
          role="assistant" sender="Codex" initials="AI" color="var(--ai-assistant)"
          content=""
          events={[{ type: 'CUSTOM', name: 'workstep.goal_update', value: {
            objective: '修复性能问题', status: 'complete', tokens_used: 42,
          } }]}
        />
      </I18nProvider>,
    ))
    assert.match(window.document.body.textContent || '', /修复性能问题/)
    assert.match(window.document.body.textContent || '', /Complete/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('goal mode is selected from the plus menu without an outer pill', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  const changes: boolean[] = []
  try {
    await act(async () => root.render(
      <I18nProvider>
        <ChatInput
          value="" onChange={() => undefined} onSend={() => undefined}
          imageAttach={{ projectId: 'project', prefix: 'chat' }}
          goal={{ active: false, onChange: (active) => changes.push(active) }}
        />
      </I18nProvider>,
    ))
    assert.equal([...window.document.querySelectorAll('.chat-input-pill')]
      .some((pill) => pill.textContent?.includes('Goal')), false)
    const plus = window.document.querySelector<HTMLButtonElement>('.chat-input-attach')
    assert.ok(plus)
    await act(async () => plus.click())
    const menuItem = [...window.document.querySelectorAll<HTMLButtonElement>('.chat-input-menu-item')]
      .find((item) => item.textContent?.includes('Goal mode'))
    assert.ok(menuItem)
    await act(async () => menuItem.click())
    assert.deepEqual(changes, [true])
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
