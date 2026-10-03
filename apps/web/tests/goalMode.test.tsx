import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ChatMessageBubble from '../src/components/ChatMessageBubble'
import ChatInput from '../src/components/ChatInput'
import ChatSessionGoalBar from '../src/components/ChatSessionGoalBar'
import { latestGoalFromMessages } from '../src/utils/goal'
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


test('goal stream displays assistant text and tools even when START was missed', async () => {
  const store = createAssistantStore({ channel: 'session_chat' })
  store.getState().addUserMessage('goal-session', '完成目标')
  const emit = (event: Record<string, unknown>) => store.getState().handleWsEvent({
    channel: 'session_chat', session_id: 'goal-session', messageId: 'reply', ...event,
  } as never)
  emit({ type: 'CUSTOM', name: 'workstep.goal_update', value: { objective: '完成目标', status: 'active' } })
  emit({ type: 'REASONING_MESSAGE_CHUNK', delta: '先检查当前实现' })
  emit({ type: 'TOOL_CALL_START', toolCallId: 'tool', toolCallName: 'Bash' })
  emit({ type: 'TEXT_MESSAGE_CONTENT', delta: '正在检查项目' })
  const session = store.getState().sessions['goal-session']
  assert.equal(session.running, true)
  assert.equal(session.messages.length, 2)
  assert.equal(session.messages[1].role, 'assistant')
  assert.equal(session.messages[1].content, '正在检查项目')
  assert.equal(session.messages[1].events?.length, 3)
  emit({ type: 'TEXT_MESSAGE_END', status: 'succeeded' })
  assert.equal(store.getState().sessions['goal-session'].messages[1].content, '正在检查项目')
  const { window } = installDomEnvironment()
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider>{session.messages.map((message) => (
      <ChatMessageBubble key={message.id} role={message.role} sender={message.role}
        initials="AI" color="var(--ai-assistant)" content={message.content} events={message.events} />
    ))}</I18nProvider>))
    assert.match(window.document.body.textContent || '', /正在检查项目/)
    assert.equal(window.document.querySelectorAll('.chat-message-row').length, 2)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('cleared goal supersedes an older active goal', () => {
  assert.equal(latestGoalFromMessages([
    { events: [{ type: 'goal_update', data: { objective: '旧目标', status: 'active' } }] },
    { events: [{ type: 'CUSTOM', name: 'workstep.goal_update', value: { status: 'cleared' } }] },
  ])?.status, 'cleared')
})

test('goal bar offers resume while idle, end while running, and hides finished goals', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  const calls: string[] = []
  const render = (running: boolean, status = 'paused') => root.render(
    <I18nProvider><ChatSessionGoalBar
      goal={{ objective: '完成目标', status }} running={running} stopping={false}
      onResume={async () => { calls.push('resume'); return true }}
      onEnd={async () => { calls.push('end'); return true }}
    /></I18nProvider>,
  )
  try {
    await act(async () => render(false))
    assert.match(window.document.body.textContent || '', /完成目标/)
    const resume = window.document.querySelector<HTMLButtonElement>('[data-goal-action="resume"]')!
    assert.equal(resume.disabled, false)
    await act(async () => resume.click())
    await act(async () => render(true, 'active'))
    assert.equal(window.document.querySelector<HTMLButtonElement>('[data-goal-action="resume"]')!.disabled, true)
    assert.ok(window.document.querySelector('.chat-session-goal-spinner'))
    await act(async () => window.document.querySelector<HTMLButtonElement>('[data-goal-action="end"]')!.click())
    assert.deepEqual(calls, ['resume', 'end'])
    await act(async () => render(false, 'complete'))
    assert.equal(window.document.querySelector('[data-goal-action="resume"]'), null)
    assert.equal(window.document.querySelector('[data-goal-action="end"]'), null)
    await act(async () => render(false, 'cleared'))
    assert.equal(window.document.querySelector('.chat-session-goal-bar'), null)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('goal original is readable during execution and after completion', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  const objective = '完整目标第一行\n\n第二行：保留全部约束和验收标准。'
  const calls: string[] = []
  const render = (status: string) => root.render(<I18nProvider><ChatSessionGoalBar
    projectId="project-1" goal={{ objective, status }} running={status === 'active'} stopping={false}
    onResume={async () => { calls.push('resume'); return true }}
    onEnd={async () => { calls.push('end'); return true }}
  /></I18nProvider>)
  try {
    await act(async () => render('active'))
    assert.equal(window.document.querySelectorAll('[data-goal-action]').length, 3)
    const view = () => window.document.querySelector<HTMLButtonElement>('[data-goal-action="original"]')!
    assert.equal(view().disabled, false)
    await act(async () => view().click())
    const dialog = window.document.querySelector('[role="dialog"]')!
    assert.ok(dialog)
    assert.match(dialog.textContent || '', /完整目标第一行/)
    assert.match(dialog.textContent || '', /第二行：保留全部约束和验收标准。/)
    await act(async () => dialog.querySelector<HTMLButtonElement>('.btn-icon')!.click())
    assert.equal(window.document.querySelector('[role="dialog"]'), null)
    await act(async () => render('complete'))
    await act(async () => view().click())
    assert.ok(window.document.querySelector('[role="dialog"]'))
    assert.deepEqual(calls, [])
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('goal actions use accessible icons on mobile and retain labels on desktop', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width: 320, height: 800 })
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><ChatSessionGoalBar
      goal={{ objective: '较长的完整目标内容', status: 'paused' }} running={false} stopping={false}
      onResume={async () => true} onEnd={async () => true}
    /></I18nProvider>))
    for (const width of [320, 390, 1023, 1024]) {
      await act(async () => window.happyDOM.setWindowSize({ width, height: 800 }))
      const buttons = [...window.document.querySelectorAll<HTMLButtonElement>('[data-goal-action]')]
      assert.equal(buttons.length, 3)
      for (const button of buttons) {
        assert.ok(button.querySelector('svg'), `${width}: icon missing`)
        assert.ok(button.getAttribute('aria-label'), `${width}: accessible name missing`)
        assert.equal(button.title, button.getAttribute('aria-label'))
        assert.equal(Boolean(button.textContent?.trim()), width > 1023)
      }
    }
    await act(async () => window.happyDOM.setWindowSize({ width: 320, height: 800 }))
    await act(async () => window.document.querySelector<HTMLButtonElement>('[data-goal-action="original"]')!.click())
    assert.match(window.document.querySelector('[role="dialog"]')?.textContent || '', /较长的完整目标内容/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
