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
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'
import { SIDEBAR_SECTION_STATE_KEY } from '../src/utils/sidebarSectionState'
import { readChatSessionDrag } from '../src/utils/chatSessionDrag'

test('dragging a real sidebar row opens its conversation in another pane and keeps sidebar reordering', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width: 1600, height: 1000 })
  const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket
  const projectState = useProjectStore.getState(), listState = useChatListStore.getState()
  const project = { id: 'p', name: 'demo', path: '/demo', steps: {}, workflows: [] }
  const sessions = ['a', 'b', 'c'].map(id => ({ id, title: id, project_id: 'p', workflow_id: '', engine: 'pydantic_ai', message_count: 1 }))
  window.localStorage.setItem(SIDEBAR_SECTION_STATE_KEY, JSON.stringify({ expandedProjectIds: ['p'], conversationsByProject: { p: true } }))
  class Socket {
    static OPEN = 1
    static CONNECTING = 0
    readyState = 1
    send() {}
    close() { this.readyState = 3 }
  }
  Object.assign(globalThis, { WebSocket: Socket, ResizeObserver: window.ResizeObserver })
  useGatewaySessionStore.setState({ session: null })
  useProjectStore.setState({ projects: [project], activeProject: project, activeWorkflowId: null })
  useChatListStore.setState({ sessionsByProject: { p: sessions }, listLoadingByProject: {}, listErrorByProject: {} })
  useChatSessionStore.setState({ sessions: {} })
  let reordered = false
  globalThis.fetch = async input => {
    const url = String(input)
    if (url.includes('/project/list')) return Response.json({ projects: [project] })
    if (url.includes('/chat-sessions/reorder')) {
      reordered = true
      return Response.json({})
    }
    if (url.includes('/chat-sessions?')) return Response.json({ sessions })
    const id = url.match(/chat-sessions\/([abc])\?/)?.[1]
    if (id) return Response.json({ id, project_id: 'p', title: id, messages: [{ id: `m-${id}`, role: 'user', content: `history-${id}` }], engine: 'pydantic_ai' })
    if (url.includes('/assistants')) return Response.json({ assistants: [{ name: 'chat_session', configured: {}, available_engines: [] }] })
    return Response.json({ sessions: [], engines: [], providers: [], buttons: [], runs: [], active_action_ids: [] })
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const transfer = new window.DataTransfer()
  const drag = (target: Element, type: string) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: transfer })
    target.dispatchEvent(event)
  }
  const rows = () => [...document.querySelectorAll<HTMLElement>('.layout-session-row')]
  try {
    await act(async () => root.render(<I18nProvider><MemoryRouter initialEntries={['/chat?project=demo&session=a']}><Layout onSelectProject={() => {}}><ChatWorkspace /></Layout></MemoryRouter></I18nProvider>))
    assert.equal(rows().length, 3)
    await act(async () => rows()[1].dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })))
    const renameInput = document.querySelector<HTMLInputElement>('.chat-session-rename-input')!
    assert.ok(renameInput, 'sidebar titles must open the shared rename dialog')
    assert.equal(renameInput.value, 'b')
    assert.equal(document.activeElement, renameInput)
    assert.equal(renameInput.selectionStart, 0)
    assert.equal(renameInput.selectionEnd, renameInput.value.length)
    assert.equal(document.querySelector('.layout-session-row input'), null)
    await act(async () => document.querySelector<HTMLButtonElement>('.confirm-dialog-footer .btn-ghost')!.click())
    assert.equal(rows()[1].getAttribute('draggable'), 'true')
    await act(async () => drag(rows()[1], 'dragstart'))
    assert.deepEqual(readChatSessionDrag(transfer as unknown as DataTransfer), { projectId: 'p', sessionId: 'b' })
    assert.equal(transfer.effectAllowed, 'copyMove')
    await act(async () => drag(document.querySelector('.chat-workspace-pane textarea')!, 'drop'))
    assert.equal(document.querySelectorAll('.chat-workspace-pane').length, 2)
    assert.match(document.querySelector('.chat-workspace-pane--active')!.textContent!, /history-b/)
    assert.equal(document.querySelector<HTMLTextAreaElement>('.chat-workspace-pane--active textarea')!.value, '', 'session payload must not enter the composer')
    await act(async () => drag(rows()[1], 'dragend'))
    await act(async () => drag(rows()[2], 'dragstart'))
    await act(async () => drag(rows()[0], 'dragover'))
    assert.equal(transfer.dropEffect, 'move')
    await act(async () => drag(rows()[0], 'drop'))
    assert.equal(reordered, true)
    assert.deepEqual(useChatListStore.getState().sessionsByProject.p.map(s => s.id), ['a', 'c', 'b'])
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    globalThis.WebSocket = originalSocket
    useProjectStore.setState(projectState)
    useChatListStore.setState(listState)
    await window.happyDOM.close()
  }
})
