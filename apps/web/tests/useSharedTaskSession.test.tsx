import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { gatewayShareApi } from '../src/api/gatewayShare'
import { useSharedTaskSession } from '../src/hooks/useSharedTaskSession'

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('protected share validates password, recovers from rejection, and loads its snapshot', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalFetch = globalThis.fetch
  const originalSocket = globalThis.WebSocket
  const unlockPasswords: string[] = []
  let socket: FakeSocket | null = null
  class FakeSocket {
    onclose: ((event: { code: number }) => void) | null = null
    constructor() { socket = this }
    close() {}
  }
  Object.assign(globalThis, { WebSocket: FakeSocket })
  globalThis.fetch = async (input, options) => {
    const url = String(input)
    if (url.endsWith('/meta')) return response({ title: 'Shared', mode: 'read_only', has_password: true })
    if (url.endsWith('/unlock')) {
      const password = JSON.parse(String(options?.body)).password
      unlockPasswords.push(password)
      return password === 'good' ? response({ session_token: 'session-1' }) : response({ detail: '401' }, 401)
    }
    if (url.endsWith('/task')) return response({ id: 'task-1', status: 'running', steps: [] })
    if (url.includes('/history?')) return response({ messages: [{ id: 'message-1', events: [] }] })
    if (url.endsWith('/artifacts')) return response({ artifacts: [], artifact_directory: '/artifacts' })
    if (url.endsWith('/reviews')) return response({ reviews: [] })
    throw new Error(`Unexpected request: ${url}`)
  }
  let session!: ReturnType<typeof useSharedTaskSession>
  function Harness() {
    session = useSharedTaskSession('share-1')
    return <div>{session.phase.kind}</div>
  }
  const flush = async () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    await flush()
    assert.equal(session.phase.kind, 'need-password')
    await act(async () => { session.setPassword('abc') })
    await act(async () => { await session.unlock() })
    assert.equal(unlockPasswords.length, 0)
    assert.ok(session.error)
    await act(async () => { session.setPassword('wrong') })
    await act(async () => { await session.unlock() })
    assert.equal(session.phase.kind, 'need-password')
    assert.ok(session.error)
    await act(async () => { session.setPassword('good') })
    await act(async () => { await session.unlock() })
    assert.equal(session.phase.kind, 'ready')
    assert.equal(session.task?.id, 'task-1')
    assert.equal(session.messages[0].id, 'message-1')
    assert.equal(session.artifactDirectory, '/artifacts')
    assert.deepEqual(unlockPasswords, ['wrong', 'good'])
    await act(async () => { socket?.onclose?.({ code: 4401 }) })
    assert.equal(session.phase.kind, 'need-password')
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    globalThis.WebSocket = originalSocket
    container.remove()
    await window.happyDOM.close()
  }
})

test('live share events update capped messages and refresh task and reviews', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalFetch = globalThis.fetch
  const originalSocket = globalThis.WebSocket
  let socket: FakeSocket | null = null
  let taskReads = 0
  let reviewReads = 0
  let unlocks = 0
  class FakeSocket {
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: ((event: { code: number }) => void) | null = null
    constructor() { socket = this }
    close() {}
  }
  Object.assign(globalThis, { WebSocket: FakeSocket })
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/meta')) return response({ mode: 'read_only', has_password: false })
    if (url.endsWith('/unlock')) return response({ session_token: `session-${++unlocks}` })
    if (url.endsWith('/task')) return response({ id: 'task-1', title: `version-${++taskReads}`, steps: [] })
    if (url.includes('/history?')) return response({ messages: [{
      id: 'message-1', events: Array.from({ length: 2001 }, (_, index) => ({ type: 'tool_use', index })),
    }] })
    if (url.endsWith('/artifacts')) return response({ artifacts: [] })
    if (url.endsWith('/reviews')) return response({ reviews: [{ id: `review-${++reviewReads}` }] })
    throw new Error(`Unexpected request: ${url}`)
  }
  let session!: ReturnType<typeof useSharedTaskSession>
  function Harness() {
    session = useSharedTaskSession('share-1')
    return <div>{session.phase.kind}</div>
  }
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
    assert.equal(session.phase.kind, 'ready')
    assert.equal(session.messages[0].events.length, 2000)
    assert.equal(session.messages[0].events[0].index, 1)
    await act(async () => socket?.onmessage?.({ data: JSON.stringify({
      type: 'CUSTOM', name: 'workstep.review_result', message_id: 'message-1',
    }) }))
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
    assert.equal(session.task?.title, 'version-2')
    assert.equal(session.reviews[0].id, 'review-2')
    assert.equal(session.messages[0].events.length, 2000)
    await act(async () => socket?.onclose?.({ code: 4401 }))
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
    assert.equal(session.phase.kind, 'ready')
    assert.equal(unlocks, 2)
    assert.equal(session.task?.title, 'version-3')
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    globalThis.WebSocket = originalSocket
    container.remove()
    await window.happyDOM.close()
  }
})

test('changing public share ignores a late snapshot from the previous token', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  let resolveOld!: (task: any) => void
  const oldTask = new Promise<any>(resolve => { resolveOld = resolve })
  const api = { ...gatewayShareApi,
    meta: async () => ({ title: 'Share', mode: 'read_only' as const, has_password: false, status: 'active' }),
    restoreSession: async () => ({ session_token: 'csrf' }),
    task: async (token: string) => token === 'old' ? oldTask : { id: 'new', title: 'New', steps: [] },
    history: async () => ({ messages: [], limit: 100, offset: 0 }),
    artifacts: async () => ({ artifacts: [], artifact_directory: '' }), reviews: async () => ({ reviews: [] }),
  } as typeof gatewayShareApi
  let session!: ReturnType<typeof useSharedTaskSession>
  function Harness({ token }: { token: string }) { session = useSharedTaskSession(token, api); return null }
  try {
    await act(async () => root.render(<I18nProvider><Harness token="old" /></I18nProvider>))
    await act(async () => root.render(<I18nProvider><Harness token="new" /></I18nProvider>))
    assert.equal(session.task?.id, 'new')
    await act(async () => resolveOld({ id: 'old', steps: [] }))
    assert.equal(session.task?.id, 'new')
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})
