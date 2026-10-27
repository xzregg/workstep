import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { I18nProvider } from '../src/i18n'
import RecentConversations from '../src/components/RecentConversations'
import ChatWorkspace from '../src/pages/ChatWorkspace'
import { useProjectStore } from '../src/stores/projectStore'
import { useChatListStore, useChatSessionStore } from '../src/stores/chatSessionStore'
import { useRecentVisitsStore } from '../src/stores/recentVisitsStore'
import { readChatSessionDrag } from '../src/utils/chatSessionDrag'
import { useWsSubscriptionStore } from '../src/hooks/useWebSocket'

test('recent chats drag across projects while histories, sends, quick buttons and remote subscriptions stay scoped', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width: 1600, height: 1000 })
  const projects = [
    { id: 'a', name: 'Alpha', path: '/alpha', steps: {}, workflows: [] },
    { id: 'b', name: 'Beta', path: '/beta', steps: {}, workflows: [] },
    { id: 'remote:c', name: 'Remote', path: '', steps: {}, workflows: [], type: 'remote' as const },
  ]
  useProjectStore.setState({ projects, activeProject: projects[0] })
  useChatListStore.setState({ sessionsByProject: { a: [], b: [], 'remote:c': [] }, quickButtons: [] })
  useChatSessionStore.setState({ sessions: {} })
  useRecentVisitsStore.getState().visit({ kind: 'session', id: 'sb', projectId: 'b', title: 'Beta recent' })
  useRecentVisitsStore.getState().visit({ kind: 'session', id: 'sc', projectId: 'remote:c', title: 'Remote recent' })
  useRecentVisitsStore.getState().visit({ kind: 'task', id: 'task', projectId: 'a', title: 'Recent task' })
  const oldFetch = globalThis.fetch
  const requests: Array<{ session: string; project: string | null }> = []
  globalThis.fetch = async input => {
    const url = new URL(String(input), 'http://localhost')
    const project = url.searchParams.get('project_id')
    const session = url.pathname.match(/chat-sessions\/(s[abc])(?:\/chat)?$/)?.[1]
    if (session && url.pathname.endsWith('/chat')) {
      requests.push({ session, project })
      return Response.json({ session_id: session, turn_id: `turn-${session}`, assistant_message_id: `reply-${session}`, status: 'running' })
    }
    if (session) {
      requests.push({ session, project })
      return Response.json({ id: session, project_id: project, title: `title-${session}`, engine: 'pydantic_ai', messages: [{ id: `history-${session}`, role: 'user', content: `history-${project}` }] })
    }
    if (url.pathname.includes('quick-buttons')) return Response.json({ buttons: [{ id: `quick-${project}`, label: `Quick ${project}`, prompt: `prompt-${project}` }] })
    if (url.pathname.includes('/assistants')) return Response.json({ assistants: [{ name: 'chat_session', configured: {}, available_engines: [] }] })
    return Response.json({ providers: [], buttons: [], runs: [], active_action_ids: [], sessions: [] })
  }
  let navigate!: ReturnType<typeof useNavigate>
  function Surface() { navigate = useNavigate(); return <><RecentConversations /><ChatWorkspace /></> }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const dragRecent = async (title: string) => {
    const row = [...document.querySelectorAll<HTMLElement>('.layout-recent-row')].find(row => row.textContent?.includes(title))!
    assert.equal(row.getAttribute('draggable'), 'true')
    const transfer = new window.DataTransfer()
    const dispatch = (target: Element, type: string) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: transfer })
      target.dispatchEvent(event)
    }
    await act(async () => dispatch(row, 'dragstart'))
    assert.ok(readChatSessionDrag(transfer as unknown as DataTransfer))
    await act(async () => dispatch(document.querySelector('.chat-workspace')!, 'drop'))
  }
  try {
    await act(async () => root.render(<I18nProvider><MemoryRouter initialEntries={['/chat?project=Alpha&session=sa']}><Surface /></MemoryRouter></I18nProvider>))
    assert.notEqual([...document.querySelectorAll('.layout-recent-row')].find(row => row.textContent?.includes('Recent task'))?.getAttribute('draggable'), 'true')
    await dragRecent('Beta recent')
    assert.equal(document.querySelectorAll('.chat-workspace-pane').length, 2)
    assert.match(document.querySelector('.chat-workspace-pane--active')!.textContent!, /history-b/)
    await dragRecent('Remote recent')
    assert.equal(document.querySelectorAll('.chat-workspace-pane').length, 3)
    assert.ok(useWsSubscriptionStore.getState().chatProjectIds.includes('remote:c'))
    const panes = [...document.querySelectorAll('.chat-workspace-pane')]
    assert.match(panes[0].textContent!, /Quick a/)
    assert.doesNotMatch(panes[0].textContent!, /Quick b/)
    assert.match(panes[1].textContent!, /Quick b/)
    for (let index = 0; index < 2; index++) {
      const input = panes[index].querySelector<HTMLTextAreaElement>('textarea')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, `send-${index}`)
        input.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
      await act(async () => panes[index].querySelector<HTMLButtonElement>('.chat-input-send')!.click())
    }
    assert.deepEqual(requests.filter(request => request.session === 'sa').map(request => request.project), ['a', 'a'])
    assert.deepEqual(requests.filter(request => request.session === 'sb').map(request => request.project), ['b', 'b'])
    await act(async () => panes[2].dispatchEvent(new window.Event('pointerdown', { bubbles: true })))
    const selectedPane = document.querySelector('.chat-workspace-pane--active')!
    const otherPane = [...document.querySelectorAll('.chat-workspace-pane')].find(pane => pane.textContent?.includes('history-b'))!
    await act(async () => navigate('/chat?project=Beta&session=sb'))
    assert.equal(document.querySelectorAll('.chat-workspace-pane').length, 3)
    assert.equal(document.querySelector('.chat-workspace-pane--active'), selectedPane, 'navigation must change the selected pane rather than focus another pane')
    assert.match(document.querySelector('.chat-workspace-pane--active')!.textContent!, /history-b/)
    assert.match(otherPane.textContent!, /history-remote:c/, 'opening an already visible chat swaps it into the selected pane')
    await act(async () => navigate('/chat?project=Alpha'))
    assert.equal(document.querySelector('.chat-workspace-pane--active'), selectedPane)
    assert.ok(selectedPane.querySelector('.chat-session-empty'), 'an unopened target also replaces the selected pane')
    assert.match(otherPane.textContent!, /history-remote:c/)
    await dragRecent('title-sc')
    assert.equal(document.querySelectorAll('.chat-workspace-pane').length, 3)
  } finally {
    await act(async () => root.unmount())
    assert.deepEqual(useWsSubscriptionStore.getState().chatProjectIds, [])
    globalThis.fetch = oldFetch
    await window.happyDOM.close()
  }
})
