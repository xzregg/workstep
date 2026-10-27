import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import ChatWorkspace from '../src/pages/ChatWorkspace'
import { I18nProvider } from '../src/i18n'
import { useProjectStore } from '../src/stores/projectStore'
import { useChatListStore, useChatSessionStore } from '../src/stores/chatSessionStore'
import { writeChatSessionDrag } from '../src/utils/chatSessionDrag'
import type { Project } from '../src/api/client'

test('desktop chat opens at most four independent panes, preserves drafts across layout changes and follows navigation', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width: 1600, height: 1000 })
  const stylesheet = document.createElement('style')
  stylesheet.textContent = ['../src/index.css', '../src/components/ConversationLayout.css', '../src/pages/ChatWorkspace.css']
    .map(path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n')
  document.head.appendChild(stylesheet)
  const project = { id: 'p', name: 'demo', path: '/demo', workflows: [] } as unknown as Project
  useProjectStore.setState({ projects: [project], activeProject: project })
  useChatListStore.setState({ sessionsByProject: { p: ['a', 'b', 'c', 'd'].map(id => ({ id, project_id: 'p', title: id })) as never } })
  useChatSessionStore.setState({ sessions: {} })
  const oldFetch = globalThis.fetch
  const sentTo: string[] = []
  let creates = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('/chat-sessions?') && init?.method === 'POST') {
      if (++creates === 1) throw new Error('创建失败，请重试')
      return Response.json({ id: 'e', project_id: 'p', title: 'e', messages: [], engine: 'pydantic_ai' })
    }
    if (url.includes('/chat-sessions?')) return Response.json({ sessions: ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, project_id: 'p', title: id })) })
    const chatId = url.match(/chat-sessions\/([a-e])\/chat\?/)?.[1]
    if (chatId) {
      sentTo.push(chatId)
      return Response.json({ session_id: chatId, turn_id: 'turn-a', assistant_message_id: 'reply-a', status: 'running' })
    }
    const id = url.match(/chat-sessions\/([a-e])(?:\?|$)/)?.[1]
    if (id) return Response.json({ id, project_id: 'p', title: id, engine: 'pydantic_ai', messages: [{ id: `m-${id}`, role: 'user', content: `history-${id}` }], running: false })
    if (url.includes('/assistants')) return Response.json({ assistants: [{ name: 'chat_session', configured: {}, available_engines: [] }] })
    return Response.json({ providers: [], buttons: [], runs: [], active_action_ids: [], sessions: [] })
  }
  let navigate: ReturnType<typeof useNavigate>
  function Navigation() { navigate = useNavigate(); return null }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
  const openWindows = () => button('对话窗口').click()
  const openArrangement = async () => {
    await act(async () => openWindows())
    await act(async () => arrangementOption('对话排列').click())
  }
  const arrangementOption = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.chat-input-menu-item')].find(item => item.textContent?.trim() === label)!
  const drop = async (id: string, projectId = 'p', typed = true) => {
    const transfer = new window.DataTransfer()
    if (typed) writeChatSessionDrag(transfer as unknown as DataTransfer, projectId, id)
    else transfer.setData('text/plain', id)
    const dragEvent = (type: string) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: transfer })
      return event
    }
    await act(async () => {
      document.querySelector('.chat-workspace')!.dispatchEvent(dragEvent('dragover'))
    })
    if (typed) assert.ok(document.querySelector('.chat-workspace--dropping'))
    await act(async () => {
      document.querySelector('.chat-workspace-pane textarea')?.dispatchEvent(dragEvent('drop'))
    })
  }
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={['/chat?project=demo&session=a']}><I18nProvider><Navigation /><ChatWorkspace /></I18nProvider></MemoryRouter>))
    assert.equal(document.querySelector('.chat-workspace-session'), null)
    assert.equal(document.querySelector('.chat-workspace-toolbar'), null)
    assert.equal(document.querySelector('.chat-workspace-pane-toolbar'), null)
    assert.ok(button('对话窗口').previousElementSibling?.textContent?.match(/New conversation|新建对话/))
    assert.ok(button('对话窗口').closest('.assistant-chat-header'))
    assert.equal(document.querySelector('[aria-label="关闭对话窗口"]'), null)
    assert.equal(document.querySelector('.chat-workspace-separator'), null)
    await act(async () => document.querySelector('.assistant-chat-header-title')!.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })))
    const renameInput = document.querySelector<HTMLInputElement>('.chat-session-rename-input')!
    assert.ok(renameInput)
    assert.equal(document.activeElement, renameInput)
    assert.equal(renameInput.selectionStart, 0)
    assert.equal(renameInput.selectionEnd, renameInput.value.length)
    await act(async () => document.querySelector<HTMLButtonElement>('.confirm-dialog-footer .btn-ghost')!.click())
    const arrangementStyle = window.getComputedStyle(button('对话窗口'))
    const renameStyle = window.getComputedStyle(button('对话窗口').nextElementSibling!)
    for (const property of ['padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'font-size', 'line-height', 'height', 'min-height']) {
      assert.equal(arrangementStyle.getPropertyValue(property), renameStyle.getPropertyValue(property), `arrangement button must match the shared header size: ${property}`)
    }
    assert.ok(button('对话窗口').nextElementSibling?.textContent?.match(/Rename|重命名/))
    await drop('b', 'another-project')
    await drop('unknown')
    await drop('b', 'p', false)
    assert.equal(document.querySelectorAll('.chat-workspace-pane').length, 1)
    for (const id of ['b', 'c', 'd']) await drop(id)
    assert.equal(document.querySelectorAll('.chat-workspace-pane').length, 4)
    assert.equal(document.querySelectorAll('.chat-workspace-separator[aria-orientation="vertical"]').length, 3)
    assert.equal(document.querySelectorAll('.chat-workspace-pane textarea').length, 4, document.querySelector('.chat-workspace')!.textContent!)
    await act(async () => openWindows())
    assert.equal(arrangementOption('增加对话窗口').disabled, true)
    await act(async () => openWindows())
    for (const pane of document.querySelectorAll('.chat-workspace-pane')) {
      const headerStyle = window.getComputedStyle(pane.querySelector('.assistant-chat-header')!)
      assert.equal(headerStyle.flexWrap, 'wrap')
      assert.equal(headerStyle.height, 'auto')
      assert.equal(headerStyle.minHeight, '40px')
      assert.equal(headerStyle.overflowX, 'visible')
      assert.equal(headerStyle.overflowY, 'visible')
      for (const button of pane.querySelectorAll('.assistant-chat-header > button')) {
        assert.equal(window.getComputedStyle(button).flexShrink, '0')
      }
      const close = pane.querySelector<HTMLElement>('[aria-label="关闭对话窗口"]')!
      const windowButton = close.nextElementSibling!
      assert.equal(windowButton.getAttribute('aria-label'), '对话窗口')
      const closeStyle = window.getComputedStyle(close)
      const windowStyle = window.getComputedStyle(windowButton)
      for (const property of ['padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'font-size', 'line-height']) {
        assert.equal(closeStyle.getPropertyValue(property), windowStyle.getPropertyValue(property), `close button must use the shared header spacing: ${property}`)
      }
      assert.equal(closeStyle.justifyContent, 'center')
    }
    await drop('e')
    assert.equal(document.querySelectorAll('.chat-workspace-pane').length, 4)
    await drop('b')
    assert.equal(document.querySelectorAll('.chat-workspace-pane').length, 4)
    assert.match(document.querySelector('.chat-workspace-pane--active')!.textContent!, /history-b/)
    const input = document.querySelector<HTMLTextAreaElement>('.chat-workspace-pane textarea')!
    await openArrangement()
    assert.ok(arrangementOption('横向排列'))
    assert.ok(arrangementOption('竖向排列'))
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '独立草稿')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
      arrangementOption('竖向排列').click()
    })
    assert.ok(document.querySelector('.chat-workspace-panes--vertical'))
    assert.equal(document.querySelectorAll('.chat-workspace-separator[aria-orientation="horizontal"]').length, 3)
    assert.equal(document.querySelector<HTMLTextAreaElement>('.chat-workspace-pane textarea')!.value, '独立草稿')
    assert.equal(document.querySelectorAll<HTMLTextAreaElement>('.chat-workspace-pane textarea')[1].value, '')
    await act(async () => document.querySelector<HTMLButtonElement>('.chat-workspace-pane .chat-input-send')!.click())
    assert.deepEqual(sentTo, ['a'])
    assert.equal(useChatSessionStore.getState().sessions.a.running, true)
    assert.equal(document.querySelector('.assistant-chat-header .task-status-spinner'), null)
    assert.equal(useChatSessionStore.getState().sessions.b.running, false)
    await act(async () => navigate!('/chat?project=demo&session=b'))
    assert.match(document.querySelector('.chat-workspace-pane--active')!.textContent!, /history-b/)
    await act(async () => button('关闭对话窗口').click())
    assert.equal(document.querySelectorAll('.chat-workspace-pane').length, 3)
    assert.ok(useChatSessionStore.getState().sessions.a)
    assert.equal(useChatSessionStore.getState().sessions.a.running, true, 'closing a pane must not stop its turn')
    await act(async () => openWindows())
    await act(async () => arrangementOption('增加对话窗口').click())
    assert.equal(document.querySelector('.chat-workspace-pane--active [aria-label="关闭对话窗口"]')?.nextElementSibling?.getAttribute('aria-label'), '对话窗口')
    const create = () => document.querySelector<HTMLButtonElement>('.chat-workspace-pane--active .chat-session-empty .btn-primary')!
    await act(async () => create().click())
    assert.match(document.querySelector('.chat-workspace-pane--active')!.textContent!, /创建失败，请重试/)
    await act(async () => create().click())
    assert.match(document.querySelector('.chat-workspace-pane--active')!.textContent!, /history-e/)
    assert.equal(document.querySelectorAll('.chat-workspace-pane textarea').length, 4)
    await openArrangement()
    await act(async () => arrangementOption('横向排列').click())
    assert.ok(document.querySelector('.chat-workspace-panes--horizontal'))
    await act(async () => { window.happyDOM.setWindowSize({ width: 390, height: 844 }) })
    assert.equal(document.querySelector('.chat-workspace-toolbar'), null)
    assert.equal(document.querySelectorAll('.chat-workspace-pane:not([hidden])').length, 1)
    assert.equal(document.querySelector('.chat-workspace-separator'), null)
    assert.equal(document.querySelectorAll('.mobile-session-kebab').length, 1)
    await act(async () => navigate!('/chat?project=demo&session=c'))
    assert.match(document.querySelector('.chat-workspace-pane:not([hidden])')!.textContent!, /history-c/)
    const second = { ...project, id: 'p2', name: 'second' }
    await act(async () => {
      useProjectStore.setState({ projects: [project, second] })
      navigate!('/chat?project=second')
    })
    assert.equal(document.querySelectorAll('.chat-workspace-pane').length, 4, 'switching projects preserves the other open panes')
    assert.ok(document.querySelector('.chat-workspace-pane--active .chat-session-empty'))
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = oldFetch
    window.happyDOM.abort()
  }
})
