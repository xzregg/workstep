import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import Layout from '../src/components/Layout'
import ChatWorkspace from '../src/pages/ChatWorkspace'
import { I18nProvider } from '../src/i18n'
import { useProjectStore } from '../src/stores/projectStore'
import { useChatListStore, useChatSessionStore } from '../src/stores/chatSessionStore'
import { useChatWorkspaceStore } from '../src/stores/chatWorkspaceStore'
import { useRecentVisitsStore } from '../src/stores/recentVisitsStore'
import { appearanceStorageKey } from '../src/utils/appearanceStorage'
import MobileHeaderActions, { MobileHeaderActionsProvider, MobileHeaderActionsSlot } from '../src/components/MobileHeaderActions'

test('header handoff renders one action set and ignores the previous owner cleanup', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const previous = <MobileHeaderActions key="old"><button>previous</button></MobileHeaderActions>
  const next = <MobileHeaderActions key="next"><button>current</button></MobileHeaderActions>
  const render = (old: boolean, current: boolean) => root.render(<MobileHeaderActionsProvider>
    <div className="mobile-header-session-actions"><MobileHeaderActionsSlot /></div>
    {old && previous}{current && next}
  </MobileHeaderActionsProvider>)
  try {
    await act(async () => render(true, false))
    assert.equal(document.querySelector('.mobile-header-session-actions')!.textContent, 'previous')
    await act(async () => render(true, true))
    assert.equal(document.querySelectorAll('button').length, 1, 'overlapping publishers never duplicate controls')
    assert.equal(document.querySelector('button')!.textContent, 'current')
    await act(async () => render(false, true))
    assert.equal(document.querySelector('button')!.textContent, 'current', 'stale cleanup cannot clear the current controls')
    await act(async () => render(false, false))
    assert.equal(document.querySelectorAll('button').length, 0)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('Android recent conversations keep one header and one set of session actions', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width: 390, height: 844 })
  Object.assign(globalThis, { history: window.history })
  Object.assign(window, { WorkStepAndroid: { postMessage() {} } })
  const project = { id: 'p', name: 'demo', path: '/demo', steps: {}, workflows: [] }
  const sessions = ['a', 'b', 'c'].map(id => ({ id, project_id: 'p', title: `对话-${id}` }))
  useProjectStore.setState({ projects: [project], activeProject: project, activeWorkflowId: null })
  useChatListStore.setState({ sessionsByProject: { p: sessions as never }, listLoadingByProject: {} })
  useChatSessionStore.setState({ sessions: {} })
  useChatWorkspaceStore.setState({ workspaces: {} })
  useChatWorkspaceStore.getState().save(appearanceStorageKey('chat-workspace'), {
    panes: sessions.map(session => ({ id: `pane-${session.id}`, projectId: 'p', sessionId: session.id })),
    layout: 'horizontal', sizes: {},
  })
  for (const session of sessions) useRecentVisitsStore.getState().visit({ kind: 'session', projectId: 'p', id: session.id, title: session.title })
  const previousFetch = globalThis.fetch
  globalThis.fetch = async input => {
    const url = String(input)
    if (url.includes('/project/list')) return Response.json({ projects: [project] })
    if (url.includes('/chat-sessions/groups?')) return Response.json({ groups: [] })
    if (url.includes('/chat-sessions?')) return Response.json({ sessions })
    const id = url.match(/chat-sessions\/([abc])(?:\?|$)/)?.[1]
    if (id) return Response.json({ id, project_id: 'p', title: `对话-${id}`, engine: 'pydantic_ai', messages: [] })
    if (url.includes('/assistants')) return Response.json({ assistants: [{ name: 'chat_session', configured: {}, available_engines: [] }] })
    return Response.json({ sessions: [], engines: [], providers: [], buttons: [], runs: [], active_action_ids: [] })
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const render = () => root.render(<I18nProvider><MemoryRouter initialEntries={['/chat?project=demo&session=a']}><Layout onSelectProject={() => {}}><ChatWorkspace /></Layout></MemoryRouter></I18nProvider>)
  const check = (id: string) => {
    assert.equal(document.querySelectorAll('.chat-workspace-pane').length, 3, 'other restored panes remain mounted')
    assert.equal(document.querySelectorAll('.mobile-header').length, 1)
    assert.equal(document.querySelector('.mobile-header-title')!.textContent, `对话-${id}`)
    for (const selector of ['.mobile-session-link', '.mobile-session-kebab']) {
      assert.equal(document.querySelectorAll(selector).length, 1, selector)
      assert.ok(document.querySelector(`.mobile-header-session-actions ${selector}`), 'session actions use a dedicated portal host')
    }
  }
  try {
    await act(async () => render())
    check('a')
    for (const id of ['b', 'c', 'a', 'c']) {
      await act(async () => document.querySelector<HTMLButtonElement>('.mobile-header [aria-controls="workstep-navigation"]')!.click())
      await act(async () => document.querySelector<HTMLButtonElement>(`.layout-recent-row[title="对话-${id}"]`)!.click())
      check(id)
    }
    await act(async () => root.render(null))
    assert.equal(document.querySelectorAll('.mobile-session-kebab').length, 0)
    await act(async () => render())
    check('a')
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = previousFetch
    await window.happyDOM.close()
  }
})
