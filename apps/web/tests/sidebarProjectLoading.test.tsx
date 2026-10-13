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
  const reload = useSidebarProjectLoading(ids)
  return <button onClick={reload}>reload</button>
}

test('failed project loads never schedule retries or request on network recovery; manual clicks retry', async () => {
  const { window } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const remote = { id: 'remote:manual', name: 'Remote', path: '', type: 'remote' as const,
    connection_status: 'disconnected' as const, steps: {}, workflows: [] }
  useGatewaySessionStore.setState({ session: null })
  useProjectStore.setState({ projects: [remote], activeProject: remote, loadError: null, remoteLoadErrors: {} })
  useChatListStore.setState({ sessionsByProject: {}, listErrorByProject: {}, listLoadingByProject: {} })
  let timers = 0
  window.setTimeout = (() => { timers++; return timers }) as typeof window.setTimeout
  let available = false
  let sessions = 0
  let snapshots = 0
  globalThis.fetch = async input => {
    const url = String(input)
    if (url.includes('/project/list')) return Response.json({ projects: [remote] })
    if (url.includes('/remote-project/')) { snapshots++; return Response.json({ ...remote, connection_status: 'connected' }) }
    sessions++
    return available ? Response.json({ sessions: [] }) : Response.json({ detail: 'offline' }, { status: 502 })
  }
  try {
    await act(async () => root.render(<Harness ids={remote.id} />))
    assert.equal(sessions, 1)
    assert.equal(timers, 0)
    available = true
    await act(async () => {
      window.dispatchEvent(new window.Event('online'))
      window.dispatchEvent(new window.Event('workstep:reconnected'))
      document.dispatchEvent(new window.Event('visibilitychange'))
    })
    assert.equal(sessions, 1)
    await act(async () => (document.querySelector('button') as HTMLButtonElement).click())
    assert.equal(sessions, 2)
    assert.equal(snapshots, 1)
    assert.equal(timers, 0)
  } finally {
    await act(async () => root.unmount()); globalThis.fetch = originalFetch; await window.happyDOM.close()
  }
})

test('switching away prevents an old request from triggering a remote snapshot', async () => {
  const { window } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const remote = { id: 'remote:old', name: 'Old', path: '', type: 'remote' as const, steps: {}, workflows: [] }
  useGatewaySessionStore.setState({ session: null })
  useProjectStore.setState({ projects: [remote], activeProject: remote, loadError: null, remoteLoadErrors: {} })
  useChatListStore.setState({ sessionsByProject: {}, listErrorByProject: {}, listLoadingByProject: {} })
  let finish!: (response: Response) => void
  let snapshots = 0
  globalThis.fetch = async input => {
    const url = String(input)
    if (url.includes('/project/list')) return Response.json({ projects: [remote] })
    if (url.includes('chat-sessions')) return new Promise<Response>(resolve => { finish = resolve })
    snapshots++
    return Response.json(remote)
  }
  try {
    await act(async () => root.render(<Harness ids={remote.id} />))
    await act(async () => root.render(<Harness ids="" />))
    await act(async () => { finish(Response.json({ sessions: [] })); await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.equal(snapshots, 0)
  } finally {
    await act(async () => root.unmount()); globalThis.fetch = originalFetch; await window.happyDOM.close()
  }
})

test('invalid credentials skip requests and initial catalog failures are not retried automatically', async () => {
  const { window } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const remote = { id: 'remote:invalid', name: 'Invalid', path: '', type: 'remote' as const,
    access_status: 'invalid' as const, steps: {}, workflows: [] }
  useGatewaySessionStore.setState({ session: null })
  useProjectStore.setState({ projects: [remote], activeProject: remote, loadError: null, remoteLoadErrors: {} })
  useChatListStore.setState({ sessionsByProject: {}, listErrorByProject: {}, listLoadingByProject: {} })
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({ detail: 'offline' }, { status: 502 }) }
  try {
    await act(async () => root.render(<Harness ids={remote.id} />))
    assert.equal(calls, 1)
    await act(async () => {
      window.dispatchEvent(new window.Event('online'))
      window.dispatchEvent(new window.Event('workstep:reconnected'))
    })
    assert.equal(calls, 1)
  } finally {
    await act(async () => root.unmount()); globalThis.fetch = originalFetch; await window.happyDOM.close()
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
