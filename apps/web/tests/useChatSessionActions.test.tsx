import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { chatSessionApi } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import { useChatSessionActions } from '../src/hooks/useChatSessionActions'
import { useChatSessionStore } from '../src/stores/chatSessionStore'

for (const scenario of ['normal', 'live', 'list-failed']) {
  const live = scenario === 'live'
  const listFailed = scenario === 'list-failed'
  test(`send establishes its accepted state even without WebSocket START (${scenario})`, async () => {
    const { window } = installDomEnvironment()
    const original = { chat: chatSessionApi.chat, sendLiveMessage: chatSessionApi.sendLiveMessage, list: chatSessionApi.list }
    let actions!: ReturnType<typeof useChatSessionActions>
    function Harness() {
      actions = useChatSessionActions({
        sessionId: 'confirmed', projectId: 'project-1', running: live,
        engineConfig: { engine: 'codex', providerId: '', model: '', fastModel: '', visionModel: '', thinkingEffort: '' },
        permissionMode: '', planMode: false, goalMode: false, effectiveEngine: 'codex',
        onSessionIdChange: () => {}, onTitleChange: () => {},
      })
      return null
    }
    const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
    try {
      chatSessionApi.chat = (async () => ({ session_id: 'confirmed', turn_id: 'saved-user',
        assistant_message_id: 'reply', status: 'queued' })) as never
      chatSessionApi.sendLiveMessage = (async () => ({ message_id: 'saved-user', created_at: '2026-10-07T05:56:08Z' })) as never
      chatSessionApi.list = (async () => {
        if (listFailed) throw new Error('连接已断开')
        return { sessions: [] }
      }) as never
      await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
      await act(async () => { assert.equal(await actions.sendPendingContent('hello', []), true) })
      const messages = useChatSessionStore.getState().sessions.confirmed.messages
      assert.deepEqual(messages.map((message) => message.id), live ? ['saved-user'] : ['saved-user', 'reply'])
      if (!live) assert.equal(useChatSessionStore.getState().sessions.confirmed.running, true)
      assert.equal(actions.sendError, '')
      if (live) assert.equal(messages[0].created_at, '2026-10-07T05:56:08Z')
    } finally {
      await act(async () => root.unmount())
      Object.assign(chatSessionApi, original)
      useChatSessionStore.getState().resetSession('confirmed')
      await window.happyDOM.close()
    }
  })
}

test('running chat falls back to a normal send when its turn has ended', async () => {
  const { window } = installDomEnvironment()
  const originalLive = chatSessionApi.sendLiveMessage
  const originalChat = chatSessionApi.chat
  const originalList = chatSessionApi.list
  const calls: string[] = []
  let root!: Root
  let actions!: ReturnType<typeof useChatSessionActions>

  function Harness() {
    actions = useChatSessionActions({
      sessionId: 'session-1', projectId: 'project-1', running: true,
      engineConfig: { engine: 'codex_sdk', providerId: '', model: '', fastModel: '', visionModel: '', thinkingEffort: '' },
      permissionMode: '', planMode: false, goalMode: false, effectiveEngine: 'codex_sdk',
      onSessionIdChange: () => {}, onTitleChange: () => {},
    })
    return null
  }

  try {
    chatSessionApi.sendLiveMessage = (async () => {
      calls.push('live')
      throw new Error('not running')
    }) as never
    chatSessionApi.chat = (async () => {
      calls.push('chat')
      return { session_id: 'session-1' }
    }) as never
    chatSessionApi.list = (async () => ({ sessions: [] })) as never
    useChatSessionStore.getState().newSession('session-1')
    const container = window.document.body.appendChild(window.document.createElement('div'))
    await act(async () => {
      root = createRoot(container as never)
      root.render(<I18nProvider><Harness /></I18nProvider>)
    })
    let accepted = false
    await act(async () => { accepted = await actions.sendPendingContent('hello', ['insert-1']) })
    assert.equal(accepted, true)
    assert.deepEqual(calls, ['live', 'chat'])
    assert.equal(actions.sendError, '')
    await act(async () => { root.unmount() })
  } finally {
    chatSessionApi.sendLiveMessage = originalLive
    chatSessionApi.chat = originalChat
    chatSessionApi.list = originalList
    useChatSessionStore.getState().resetSession('session-1')
    await window.happyDOM.close()
  }
})


for (const scenario of ['resume', 'end-running', 'end-idle', 'stop-failed', 'clear-failed']) {
  test(`goal controls: ${scenario}`, async () => {
    const { window } = installDomEnvironment()
    const original = { chat: chatSessionApi.chat, stop: chatSessionApi.stop, list: chatSessionApi.list }
    const calls: string[] = []
    let actions!: ReturnType<typeof useChatSessionActions>
    const sessionId = `goal-${scenario}`
    function Harness() {
      actions = useChatSessionActions({
        sessionId, projectId: 'project-1', running: scenario !== 'resume' && scenario !== 'end-idle',
        engineConfig: { engine: 'codex_sdk', providerId: '', model: '', fastModel: '', visionModel: '', thinkingEffort: '' },
        permissionMode: '', planMode: true, goalMode: true, effectiveEngine: 'codex_sdk',
        onSessionIdChange: () => {}, onTitleChange: () => {},
      })
      return null
    }
    const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
    try {
      chatSessionApi.stop = (async () => {
        calls.push('stop')
        return { stopped: scenario !== 'stop-failed' }
      }) as never
      chatSessionApi.chat = (async (_id, projectId, content, _key, overrides) => {
        calls.push(content)
        assert.equal(projectId, 'project-1')
        assert.equal(overrides?.goal_mode, false)
        assert.equal(overrides?.plan_mode, false)
        if (scenario === 'clear-failed') throw new Error('clear failed')
        return { session_id: sessionId }
      }) as typeof chatSessionApi.chat
      chatSessionApi.list = (async () => ({ sessions: [] })) as never
      useChatSessionStore.getState().newSession(sessionId)
      await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
      let accepted = false
      await act(async () => { accepted = await (scenario === 'resume' ? actions.continueGoal() : actions.endGoal()) })
      assert.equal(accepted, scenario !== 'stop-failed' && scenario !== 'clear-failed')
      assert.deepEqual(calls, scenario === 'resume' ? ['/goal resume']
        : scenario === 'end-idle' ? ['/goal clear']
        : scenario === 'stop-failed' ? ['stop'] : ['stop', '/goal clear'])
      if (scenario === 'clear-failed') {
        assert.equal(actions.sendError, 'clear failed')
        assert.equal(useChatSessionStore.getState().sessions[sessionId].messages.length, 0)
      }
    } finally {
      await act(async () => root.unmount())
      Object.assign(chatSessionApi, original)
      useChatSessionStore.getState().resetSession(sessionId)
      await window.happyDOM.close()
    }
  })
}


for (const scenario of ['omitted', 'selected', 'cleared', 'live', 'fallback'] as const) {
  test(`provider selection in chat send: ${scenario}`, async () => {
    const { window } = installDomEnvironment()
    const original = { chat: chatSessionApi.chat, sendLiveMessage: chatSessionApi.sendLiveMessage, list: chatSessionApi.list }
    const calls: string[] = []
    let actions!: ReturnType<typeof useChatSessionActions>
    function Harness() {
      actions = useChatSessionActions({
        sessionId: 'provider-session', projectId: 'project-1', running: scenario === 'live' || scenario === 'fallback',
        engineConfig: { engine: 'codex_sdk', providerId: scenario === 'selected' ? 'chosen-provider' : '',
          providerCleared: ['cleared', 'live', 'fallback'].includes(scenario),
          model: '', fastModel: '', visionModel: '', thinkingEffort: '' },
        permissionMode: '', planMode: false, goalMode: false, effectiveEngine: 'codex_sdk',
        onSessionIdChange: () => {}, onTitleChange: () => {},
      })
      return null
    }
    const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
    try {
      chatSessionApi.chat = (async (_id, _project, _content, _key, overrides) => {
        calls.push('chat')
        assert.equal(overrides?.provider_id, scenario === 'omitted' ? undefined : scenario === 'selected' ? 'chosen-provider' : '')
        return { session_id: 'provider-session' }
      }) as typeof chatSessionApi.chat
      chatSessionApi.sendLiveMessage = (async (...args) => {
        calls.push('live')
        assert.deepEqual(args, ['provider-session', 'project-1', 'hello', ['insert-1']])
        if (scenario === 'fallback') throw new Error('not running')
        return { accepted: true }
      }) as never
      chatSessionApi.list = (async () => ({ sessions: [] })) as never
      useChatSessionStore.getState().newSession('provider-session')
      await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
      let accepted = false
      await act(async () => { accepted = await actions.sendPendingContent('hello', ['insert-1']) })
      assert.equal(accepted, true)
      assert.deepEqual(calls, scenario === 'live' ? ['live'] : scenario === 'fallback' ? ['live', 'chat'] : ['chat'])
    } finally {
      await act(async () => root.unmount())
      Object.assign(chatSessionApi, original)
      useChatSessionStore.getState().resetSession('provider-session')
      await window.happyDOM.close()
    }
  })
}
