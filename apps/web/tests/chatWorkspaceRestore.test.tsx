import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import { I18nProvider } from '../src/i18n'
import ChatWorkspace from '../src/pages/ChatWorkspace'
import { useProjectStore } from '../src/stores/projectStore'
import { useChatListStore, useChatSessionStore } from '../src/stores/chatSessionStore'
import { useChatWorkspaceStore } from '../src/stores/chatWorkspaceStore'
import { writeChatSessionDrag } from '../src/utils/chatSessionDrag'
import { setAppearanceScope } from '../src/utils/appearanceStorage'

test('returning from task and workflow routes restores panes, layout, sizes and drafts with the first pane selected', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width: 1600, height: 1000 })
  const project = { id: 'p', name: 'Alpha', path: '/alpha', steps: {}, workflows: [] }
  const sessions = ['s1', 's2', 's3', 's4'].map(id => ({ id, project_id: 'p', title: id }))
  useChatWorkspaceStore.setState({ workspaces: {} })
  useProjectStore.setState({ projects: [project], activeProject: project })
  useChatListStore.setState({ sessionsByProject: { p: sessions as never } })
  useChatSessionStore.setState({ sessions: {} })
  const oldFetch = globalThis.fetch
  globalThis.fetch = async input => {
    const url = String(input)
    const id = url.match(/chat-sessions\/(s[1-4])\?/)?.[1]
    if (id) return Response.json({ id, project_id: 'p', title: id, engine: 'pydantic_ai', messages: [{ id: `m-${id}`, role: 'user', content: `history-${id}` }] })
    if (url.includes('/assistants')) return Response.json({ assistants: [{ name: 'chat_session', configured: {}, available_engines: [] }] })
    return Response.json({ sessions, providers: [], buttons: [], runs: [], active_action_ids: [] })
  }
  let navigate!: ReturnType<typeof useNavigate>
  function Surface() {
    navigate = useNavigate()
    const location = useLocation()
    return <><output>{location.search}</output><Routes><Route path="/chat" element={<ChatWorkspace />} /><Route path="*" element={<span>Other page</span>} /></Routes></>
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const panes = () => [...document.querySelectorAll<HTMLElement>('.chat-workspace-pane')]
  const option = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.chat-input-menu-item')].find(button => button.textContent?.trim() === text)!
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={['/chat?project=Alpha&session=s1']}><I18nProvider><Surface /></I18nProvider></MemoryRouter>))
    for (const id of ['s2', 's3', 's4']) await act(async () => {
      const transfer = new window.DataTransfer()
      writeChatSessionDrag(transfer as unknown as DataTransfer, 'p', id)
      const event = new window.Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: transfer })
      document.querySelector('.chat-workspace')!.dispatchEvent(event)
    })
    const input = panes()[0].querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '保留草稿')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
      panes()[3].querySelector<HTMLButtonElement>('[aria-label="对话窗口"]')!.click()
    })
    await act(async () => option('对话排列').click())
    await act(async () => option('竖向排列').click())
    for (const pane of panes()) pane.getBoundingClientRect = () => ({ width: 500, height: 400 }) as DOMRect
    await act(async () => document.querySelector('[role="separator"]')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    const sizes = document.querySelector<HTMLElement>('.chat-workspace-panes')!.style.gridTemplateRows
    await act(async () => navigate('/tasks'))
    assert.equal(panes().length, 0)
    await act(async () => navigate('/chat?project=Alpha&session=s2'))
    assert.equal(panes().length, 4)
    assert.equal(document.querySelector('.chat-workspace-pane--active'), panes()[0])
    assert.match(panes()[0].textContent!, /history-s2/)
    assert.match(panes()[1].textContent!, /history-s1/)
    assert.equal(panes()[1].querySelector<HTMLTextAreaElement>('textarea')!.value, '保留草稿')
    assert.ok(document.querySelector('.chat-workspace-panes--vertical'))
    assert.equal(document.querySelector<HTMLElement>('.chat-workspace-panes')!.style.gridTemplateRows, sizes)
    await act(async () => panes()[2].dispatchEvent(new window.Event('pointerdown', { bubbles: true })))
    await act(async () => navigate('/chat?project=Alpha&session=s4'))
    assert.equal(document.querySelector('.chat-workspace-pane--active'), panes()[2])
    assert.match(panes()[2].textContent!, /history-s4/)
    await act(async () => navigate('/canvas'))
    await act(async () => navigate('/chat?project=Alpha'))
    assert.equal(panes().length, 4)
    assert.equal(document.querySelector('.chat-workspace-pane--active'), panes()[0])
    assert.match(panes()[0].textContent!, /history-s2/)
    assert.match(document.querySelector('output')!.textContent!, /session=s2/)
    await act(async () => panes()[3].querySelector<HTMLButtonElement>('[aria-label="关闭对话窗口"]')!.click())
    await act(async () => navigate('/tasks'))
    await act(async () => navigate('/chat?project=Alpha&session=s2'))
    assert.equal(panes().length, 3, 'closed panes must not reappear')
    await act(async () => navigate('/tasks'))
    setAppearanceScope('another-user')
    await act(async () => navigate('/chat?project=Alpha&session=s1'))
    assert.equal(panes().length, 1, 'workspace state is isolated by account scope')
  } finally {
    await act(async () => root.unmount())
    useChatWorkspaceStore.setState({ workspaces: {} })
    setAppearanceScope(null)
    globalThis.fetch = oldFetch
    await window.happyDOM.close()
  }
})
