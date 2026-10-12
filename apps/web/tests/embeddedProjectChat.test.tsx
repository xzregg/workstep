import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import ChatPage from '../src/pages/ChatPage'
import { I18nProvider } from '../src/i18n'
import { useProjectStore } from '../src/stores/projectStore'

test('embedded skin chat loads the ordinary session without changing the selected project or route', async () => {
  const { window } = installDomEnvironment()
  const previousFetch = globalThis.fetch, previousProject = useProjectStore.getState()
  const calls: string[] = []
  const original = { id: 'original', name: '日常项目', path: '/tmp/original', workflows: [], steps: {} }
  const design = { id: 'skin-project', name: '皮肤设计', path: '/tmp/skin-project', workflows: [], steps: {} }
  useProjectStore.setState({ projects: [original, design], activeProject: original })
  globalThis.fetch = async input => {
    const url = String(input); calls.push(url)
    if (url.includes('/chat-sessions/skin-session')) return Response.json({ id: 'skin-session', project_id: design.id, title: '我的皮肤', messages: [], engine: 'pydantic_ai', running: false })
    if (url.includes('/assistants')) return Response.json({ assistants: [{ name: 'chat_session', configured: { engine: 'pydantic_ai' }, resolved: {}, available_engines: [] }] })
    return Response.json({ providers: [], buttons: [], sessions: [], runs: [], active_action_ids: [] })
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={['/tasks?project=日常项目']}><I18nProvider><ChatPage embedded={{ project: design, sessionId: 'skin-session', onSessionChange: () => {} }} /></I18nProvider></MemoryRouter>))
    assert.ok(calls.some(url => url.includes('/chat-sessions/skin-session') && url.includes('project_id=skin-project')))
    assert.equal(useProjectStore.getState().activeProject?.id, original.id)
    assert.ok(document.querySelector('.assistant-chat-panel'))
    assert.equal(document.querySelector('.mobile-session-kebab'), null)
  } finally { await act(async () => root.unmount()); globalThis.fetch = previousFetch; useProjectStore.setState(previousProject); await window.happyDOM.close() }
})
