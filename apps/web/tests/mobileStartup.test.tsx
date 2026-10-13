import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { installDomEnvironment } from './helpers/domEnv'
import { useCompactLayout } from '../src/hooks/useCompactLayout'
import ChatPage from '../src/pages/ChatPage'
import { I18nProvider } from '../src/i18n'
import { assistantApi, chatSessionApi, providerApi } from '../src/api/client'
import { useProjectStore } from '../src/stores/projectStore'
import { useChatSessionStore } from '../src/stores/chatSessionStore'

function LayoutProbe() { return <output>{useCompactLayout() ? 'mobile' : 'desktop'}</output> }

test('first layout snapshot uses the viewport instead of a desktop placeholder', async () => {
  const { window } = installDomEnvironment()
  try {
    for (const width of [320, 390, 1023, 1280]) {
      window.innerWidth = width
      assert.equal(renderToString(<LayoutProbe />), `<output>${width <= 1023 ? 'mobile' : 'desktop'}</output>`)
    }
  } finally { await window.happyDOM.close() }
})

test('entry loads mobile CSS before application scripts', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const head = html.slice(0, html.indexOf('</head>'))
  assert.match(head, /<link[^>]+rel="stylesheet"[^>]+href="\/src\/index.css"/)
  assert.match(head, /<link[^>]+rel="stylesheet"[^>]+href="\/src\/mobile.css"/)
  assert.ok(head.indexOf('name="viewport"') < head.indexOf('/src/mobile.css'))
})

test('pending mobile chat history shows an animated spinner and removes it on failure', async () => {
  const { window, document } = installDomEnvironment()
  window.innerWidth = 390
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ engines: [], sessions: [], providers: [], actions: [], runs: [], active_action_ids: [] })
  const originals = { get: chatSessionApi.get, list: chatSessionApi.list, quick: chatSessionApi.quickButtons, assistants: assistantApi.list, providers: providerApi.list }
  let rejectHistory!: (reason: Error) => void
  chatSessionApi.get = () => new Promise((_, reject) => { rejectHistory = reject })
  chatSessionApi.list = async () => ({ sessions: [] })
  chatSessionApi.quickButtons = async () => ({ buttons: [] })
  assistantApi.list = async () => ({ assistants: [] })
  providerApi.list = async () => ({ providers: [] })
  const oldProject = useProjectStore.getState()
  const oldSessions = useChatSessionStore.getState()
  const project = { id: 'loading', name: 'loading', path: '/tmp/loading', workflows: [] }
  useProjectStore.setState({ activeProject: project as never, projects: [project] as never })
  useChatSessionStore.setState({ sessions: {} })
  const styles = document.head.appendChild(document.createElement('style'))
  styles.textContent = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={['/chat?project=loading&session=session']}><I18nProvider><ChatPage /></I18nProvider></MemoryRouter>))
    const spinner = document.querySelector('.chat-session-empty[role="status"] .spinner')
    assert.ok(spinner)
    assert.match(window.getComputedStyle(spinner).animation, /task-status-spin.*infinite/)
    await act(async () => rejectHistory(new Error('加载失败')))
    assert.equal(document.querySelector('.chat-session-empty[role="status"]'), null)
    assert.ok(document.querySelector('[role="alert"]'))
  } finally {
    await act(async () => root.unmount())
    chatSessionApi.get = originals.get; chatSessionApi.list = originals.list; chatSessionApi.quickButtons = originals.quick
    assistantApi.list = originals.assistants; providerApi.list = originals.providers
    useProjectStore.setState(oldProject); useChatSessionStore.setState(oldSessions)
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})
