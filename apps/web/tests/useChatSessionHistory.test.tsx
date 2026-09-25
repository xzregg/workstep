import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { chatSessionApi } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import { useChatSessionHistory } from '../src/hooks/useChatSessionHistory'
import { useChatSessionStore } from '../src/stores/chatSessionStore'

test('session history loads once when a caller updates its catalog callback', async () => {
  const { window } = installDomEnvironment()
  const originalGet = chatSessionApi.get
  let requests = 0
  let root!: Root
  let updateCatalog!: () => void
  let loadedTitle = ''

  function Harness() {
    const [version, setVersion] = useState(0)
    updateCatalog = () => setVersion((current) => current + 1)
    useChatSessionHistory({
      sessionId: 'session-1', projectId: 'project-1',
      onLoaded: (detail) => { loadedTitle = `${detail.title}:${version}` },
      onMissing: () => {},
    })
    return null
  }

  try {
    chatSessionApi.get = (async (sessionId: string) => {
      requests += 1
      return {
        id: sessionId, project_id: 'project-1', workflow_id: null,
        title: '会话', engine: '', provider_id: '', model: '',
        fast_model: '', vision_model: '', permission_mode: '',
        message_count: 0, messages: [], running: false,
        created_at: '', updated_at: '',
      }
    }) as never
    useChatSessionStore.setState({ sessions: {} })
    const container = window.document.body.appendChild(window.document.createElement('div'))
    await act(async () => {
      root = createRoot(container as never)
      root.render(<I18nProvider><Harness /></I18nProvider>)
    })
    assert.equal(requests, 1)
    assert.equal(loadedTitle, '会话:0')
    await act(async () => { updateCatalog() })
    assert.equal(requests, 1)
    await act(async () => { root.unmount() })
  } finally {
    chatSessionApi.get = originalGet
    useChatSessionStore.setState({ sessions: {} })
    await window.happyDOM.close()
  }
})

test('event details follow the current session id after a send migrates it', async () => {
  const { window } = installDomEnvironment()
  const originalEvents = chatSessionApi.messageEvents
  const requests: string[] = []
  let root!: Root
  let history!: ReturnType<typeof useChatSessionHistory>

  function Harness() {
    history = useChatSessionHistory({
      sessionId: null,
      messageSessionId: 'migrated-session',
      projectId: 'project-1',
      onLoaded: () => {}, onMissing: () => {},
    })
    return null
  }

  try {
    chatSessionApi.messageEvents = (async (sessionId) => {
      requests.push(sessionId)
      return { events: [], complete: true, next_cursor: null }
    }) as never
    const store = useChatSessionStore.getState()
    store.newSession('migrated-session')
    store.hydrateSession('migrated-session', [{
      id: 'message-1', role: 'assistant', content: '', status: 'succeeded',
      event_detail: { available: true, loaded: false }, events: [],
    } as never], false)
    const container = window.document.body.appendChild(window.document.createElement('div'))
    await act(async () => {
      root = createRoot(container as never)
      root.render(<I18nProvider><Harness /></I18nProvider>)
    })
    await act(async () => { await history.loadMessageEvents('message-1') })
    assert.deepEqual(requests, ['migrated-session'])
    await act(async () => { root.unmount() })
  } finally {
    chatSessionApi.messageEvents = originalEvents
    useChatSessionStore.setState({ sessions: {} })
    await window.happyDOM.close()
  }
})
