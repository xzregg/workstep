import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useSidebarProjectLoading } from '../src/hooks/useSidebarProjectLoading'
import { useProjectStore } from '../src/stores/projectStore'
import { useChatListStore } from '../src/stores/chatSessionStore'
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'
import SidebarLoadStatus from '../src/components/SidebarLoadStatus'
import { I18nProvider } from '../src/i18n'

function Harness({ ids }: { ids: string }) {
  useSidebarProjectLoading(ids)
  return null
}

test('only failures schedule exponential retries and recovery leaves no timer or full catalog requests', async () => {
  const { window } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const remote = { id: 'remote:retry', name: 'Retry', path: '', type: 'remote' as const,
    connection_status: 'disconnected' as const, access_status: 'active' as const, steps: {}, workflows: [] }
  useGatewaySessionStore.setState({ session: null })
  useProjectStore.setState({ projects: [remote], activeProject: null, loadError: null, remoteLoadErrors: {} })
  useChatListStore.setState({ sessionsByProject: {}, listErrorByProject: {}, listLoadingByProject: {} })
  const timers = new Map<number, { callback: () => void; delay: number }>()
  let timerId = 0
  window.setTimeout = ((callback: () => void, delay: number) => {
    timers.set(++timerId, { callback, delay })
    return timerId
  }) as typeof window.setTimeout
  window.clearTimeout = ((id: number) => { timers.delete(id) }) as typeof window.clearTimeout
  let available = false
  let catalogs = 0
  let sessions = 0
  let snapshots = 0
  globalThis.fetch = async input => {
    if (String(input).includes('/project/list')) { catalogs++; return Response.json({ projects: [remote] }) }
    if (String(input).includes('/remote-project/')) {
      snapshots++
      return Response.json({ ...remote, connection_status: 'connected', workflows: [] })
    }
    sessions++
    return available ? Response.json({ sessions: [] }) : Response.json({ detail: 'offline' }, { status: 502 })
  }
  const tick = async () => {
    const [id, timer] = [...timers.entries()][0]
    timers.delete(id)
    await act(async () => { timer.callback(); await new Promise(resolve => setTimeout(resolve, 0)) })
  }
  try {
    await act(async () => root.render(<Harness ids={remote.id} />))
    assert.equal(timers.size, 1)
    assert.equal([...timers.values()][0].delay, 2000)
    await tick()
    assert.equal([...timers.values()][0].delay, 4000)
    assert.equal(catalogs, 1)
    for (const expectedDelay of [8000, 16000, 32000, 60000, 60000]) {
      await tick()
      assert.equal([...timers.values()][0].delay, expectedDelay)
    }
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => document.dispatchEvent(new window.Event('visibilitychange')))
    assert.equal(timers.size, 0)
    const failedAttempts = sessions
    await act(async () => window.dispatchEvent(new window.Event('online')))
    assert.equal(sessions, failedAttempts)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    available = true
    await act(async () => { document.dispatchEvent(new window.Event('visibilitychange')); await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.equal(timers.size, 0)
    assert.equal(sessions, failedAttempts + 1)
    assert.equal(snapshots, 1)
    await act(async () => { window.dispatchEvent(new window.Event('online')) })
    assert.equal(timers.size, 0)
    assert.equal(catalogs, 1)
    assert.equal(sessions, failedAttempts + 1)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

test('expanded inactive remote project recovers conversations and workflows after an initial failure', async () => {
  const { window } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const remote = { id: 'remote:p', path: '', name: 'Remote', type: 'remote' as const,
    connection_status: 'disconnected' as const, access_status: 'active' as const, steps: {}, workflows: [] }
  useGatewaySessionStore.setState({ session: null })
  useProjectStore.setState({ projects: [remote], activeProject: null, loadError: null })
  useChatListStore.setState({ sessionsByProject: {}, listErrorByProject: {}, listLoadingByProject: {} })
  let available = false
  let catalogCalls = 0
  let sessionCalls = 0
  let snapshotCalls = 0
  globalThis.fetch = async input => {
    if (String(input).includes('/project/list')) {
      catalogCalls++
      return Response.json({ projects: [{ ...remote, connection_status: available ? 'connected' : 'disconnected',
        workflows: available ? [{ id: 'wf', name: 'Flow', is_default: true, nodeCount: 1 }] : [] }] })
    }
    if (String(input).includes('/remote-project/')) {
      snapshotCalls++
      return Response.json({ ...remote, connection_status: 'connected',
        workflows: [{ id: 'wf', name: 'Flow', is_default: true, nodeCount: 1 }] })
    }
    sessionCalls++
    return available ? Response.json({ sessions: [{ id: 'chat', project_id: remote.id, title: 'Recovered' }] })
      : Response.json({ detail: 'offline' }, { status: 502 })
  }
  try {
    await act(async () => root.render(<Harness ids={remote.id} />))
    assert.equal(sessionCalls, 1)
    assert.equal(useChatListStore.getState().listErrorByProject[remote.id], 'offline')
    available = true
    await act(async () => { window.dispatchEvent(new window.Event('online')); await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.equal(sessionCalls, 2)
    assert.equal(useChatListStore.getState().sessionsByProject[remote.id][0].title, 'Recovered')
    assert.equal(useProjectStore.getState().projects[0].workflows[0].id, 'wf')
    assert.equal(catalogCalls, 1, 'remote recovery never reloads every local project')
    assert.equal(snapshotCalls, 1)
    const beforeUnmount = catalogCalls
    await act(async () => root.unmount())
    window.dispatchEvent(new window.Event('online'))
    assert.equal(catalogCalls, beforeUnmount)
  } finally {
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

test('reopening a loaded project reuses cached conversations', async () => {
  const { window } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const project = { id: 'cached', name: 'Cached', path: '', steps: {}, workflows: [] }
  useGatewaySessionStore.setState({ session: null })
  useProjectStore.setState({ projects: [project], activeProject: null, loadError: null, remoteLoadErrors: {} })
  useChatListStore.setState({ sessionsByProject: { cached: [] }, listErrorByProject: {}, listLoadingByProject: {} })
  let conversations = 0
  globalThis.fetch = async input => {
    if (String(input).includes('chat-sessions')) conversations++
    return Response.json({ projects: [project], sessions: [] })
  }
  try {
    await act(async () => root.render(<Harness ids="cached" />))
    await act(async () => root.render(<Harness ids="" />))
    await act(async () => root.render(<Harness ids="cached" />))
    assert.equal(conversations, 0)
  } finally {
    await act(async () => root.unmount()); globalThis.fetch = originalFetch; await window.happyDOM.close()
  }
})

test('initial catalog failure retries online without any known projects', async () => {
  const { window } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  useGatewaySessionStore.setState({ session: null })
  useProjectStore.setState({ projects: [], activeProject: null, loadError: null })
  let calls = 0
  globalThis.fetch = async () => ++calls === 1
    ? Response.json({ detail: 'gateway unavailable' }, { status: 502 })
    : Response.json({ projects: [{ id: 'p', name: 'Recovered', workflows: [], steps: {}, path: '' }] })
  try {
    await act(async () => root.render(<Harness ids="" />))
    assert.equal(useProjectStore.getState().loadError, 'gateway unavailable')
    await act(async () => { window.dispatchEvent(new window.Event('online')); await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.equal(useProjectStore.getState().projects[0].id, 'p')
    assert.equal(useProjectStore.getState().loadError, null)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

test('list status distinguishes loading from failure and offers retry', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let retries = 0
  try {
    await act(async () => root.render(<I18nProvider><SidebarLoadStatus loading label="对话列表加载失败" onRetry={() => retries++} /></I18nProvider>))
    assert.ok(container.querySelector('[role="status"]'))
    assert.equal(container.querySelector('button'), null)
    await act(async () => root.render(<I18nProvider><SidebarLoadStatus error="offline" label="对话列表加载失败" onRetry={() => retries++} /></I18nProvider>))
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /对话列表加载失败/)
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click())
    assert.equal(retries, 1)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
