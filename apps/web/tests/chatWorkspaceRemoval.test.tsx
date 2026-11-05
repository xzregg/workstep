import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { I18nProvider } from '../src/i18n'
import ChatWorkspace from '../src/pages/ChatWorkspace'
import { useSidebarSessionActions } from '../src/hooks/useSidebarSessionActions'
import { useChatWorkspaceStore } from '../src/stores/chatWorkspaceStore'
import { useProjectStore } from '../src/stores/projectStore'
import { useChatListStore, useChatSessionStore } from '../src/stores/chatSessionStore'
import { chatSessionApi } from '../src/api/client'
import { appearanceStorageKey } from '../src/utils/appearanceStorage'

for (const action of ['archiveSession', 'deleteSession', 'bulkRemove'] as const) {
  test(`${action} closes matching panes only after success and persists the remaining workspace`, async () => {
    const { window } = installDomEnvironment()
    window.happyDOM.setWindowSize({ width: 1600, height: 1000 })
    const projects = [
      { id: 'p', name: 'Alpha', path: '/alpha', steps: {}, workflows: [] },
      { id: 'q', name: 'Beta', path: '/beta', steps: {}, workflows: [] },
    ]
    useProjectStore.setState({ projects, activeProject: projects[0] })
    useChatListStore.setState({ sessionsByProject: { p: ['a', 'b'].map(id => ({ id, project_id: 'p', title: id })), q: [{ id: 'b', project_id: 'q', title: 'other-b' }] } as never })
    useChatSessionStore.setState({ sessions: {} })
    const scope = appearanceStorageKey('chat-workspace')
    useChatWorkspaceStore.getState().save(scope, { panes: [
      { id: 'first', projectId: 'p', sessionId: 'a' },
      { id: 'second', projectId: 'p', sessionId: 'b' },
      { id: 'third', projectId: 'q', sessionId: 'b' },
    ], layout: 'horizontal', sizes: {} })
    const oldFetch = globalThis.fetch
    const oldRemove = chatSessionApi.remove, oldArchive = chatSessionApi.setArchived, oldBulk = chatSessionApi.bulkDelete
    let fail = true
    const remove = async () => { if (fail) throw new Error('failed'); return {} as never }
    chatSessionApi.remove = remove
    chatSessionApi.setArchived = remove
    chatSessionApi.bulkDelete = async (_projectId, ids) => {
      await remove()
      return { deleted: ids.slice(0, 1), skipped: ids.slice(1) }
    }
    globalThis.fetch = async input => {
      const url = new URL(String(input), 'http://localhost')
      const id = url.pathname.match(/chat-sessions\/([ab])$/)?.[1]
      if (id) return Response.json({ id, project_id: url.searchParams.get('project_id'), title: id, engine: 'pydantic_ai', messages: [] })
      if (url.pathname.includes('/assistants')) return Response.json({ assistants: [{ name: 'chat_session', configured: {}, available_engines: [] }] })
      return Response.json({ sessions: [], providers: [], buttons: [], runs: [], active_action_ids: [] })
    }
    let controls!: ReturnType<typeof useSidebarSessionActions>
    const perform = async (id: string, projectId: string) => {
      if (action !== 'bulkRemove') return controls[action](id, projectId)
      useChatListStore.setState({ selectedIds: new Set(projectId === 'p' && id === 'b' ? ['b', 'a'] : [id]), selectionProjectId: projectId })
      return useChatListStore.getState().bulkRemove(projectId)
    }
    let search = ''
    function Surface() { controls = useSidebarSessionActions(); search = useLocation().search; return <ChatWorkspace /> }
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    const panes = () => [...document.querySelectorAll<HTMLElement>('.chat-workspace-pane')]
    try {
      await act(async () => root.render(<I18nProvider><MemoryRouter initialEntries={['/chat?project=Alpha&session=a']}><Surface /></MemoryRouter></I18nProvider>))
      const first = panes()[0], third = panes()[2]
      await act(async () => { await perform('b', 'p') })
      assert.equal(panes().length, 3, 'failure preserves all panes')
      await act(async () => third.dispatchEvent(new window.Event('pointerdown', { bubbles: true })))
      assert.equal(document.querySelector('.chat-workspace-pane--active'), third)
      fail = false
      await act(async () => { await perform('b', 'p') })
      assert.deepEqual(panes(), [first, third], 'matching pane closes without touching another project')
      assert.equal(document.querySelector('.chat-workspace-pane--active'), first, 'closing even an inactive pane activates the first remaining pane')
      assert.equal(new URLSearchParams(search).get('session'), 'a')
      await act(async () => { await perform('a', 'p') })
      assert.deepEqual(panes(), [third], 'removing the active pane activates a remaining pane')
      assert.equal(new URLSearchParams(search).get('project'), 'Beta')
      assert.equal(new URLSearchParams(search).get('session'), 'b')
      useChatWorkspaceStore.setState({ workspaces: {} })
      assert.deepEqual(useChatWorkspaceStore.getState().restore(scope)?.panes.map(pane => pane.projectId), ['q'], 'closed panes stay removed from persistent storage')
      await act(async () => { await perform('b', 'q') })
      assert.equal(panes().length, 1, 'the last pane becomes an empty workspace')
      assert.ok(panes()[0].querySelector('.chat-session-empty'))
      assert.equal(new URLSearchParams(search).has('session'), false)
    } finally {
      await act(async () => root.unmount())
      globalThis.fetch = oldFetch
      chatSessionApi.remove = oldRemove
      chatSessionApi.setArchived = oldArchive
      chatSessionApi.bulkDelete = oldBulk
      useChatWorkspaceStore.setState({ workspaces: {} })
      await window.happyDOM.close()
    }
  })
}
