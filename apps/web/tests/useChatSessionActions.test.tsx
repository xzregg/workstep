import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { chatSessionApi } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import { useChatSessionActions } from '../src/hooks/useChatSessionActions'
import { useChatSessionStore } from '../src/stores/chatSessionStore'

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
