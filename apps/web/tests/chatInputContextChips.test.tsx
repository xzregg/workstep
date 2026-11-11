import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider } from '../src/i18n'
import ChatInput from '../src/components/ChatInput'
import { connectorApi } from '../src/api/connectors'

test('role and connector chips live inside the editor without changing sent text', async () => {
  const { window } = installDomEnvironment()
  const original = { ...connectorApi }, oldFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ enabled: false })
  connectorApi.available = async () => ({ connectors: [{ id: 'github', name: 'GitHub', kind: 'mcp', selected: true, available: true, description: '' }] })
  let selected = ['github'], opened = 0, removed = 0, draft = '只发送用户正文', sent = ''
  window.localStorage.setItem('workstep-chat-draft:context-chip-test', draft)
  connectorApi.select = async (_project, _session, ids) => { selected = ids; return { ok: true } }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const render = (loading = false) => root.render(<I18nProvider><ChatInput
    value={draft} onChange={value => { draft = value }} onSend={() => { sent = draft }}
    projectId="project" sessionId="context-chip-test" connectorsEnabled
    roleBinding={{ name: '产品专家', missing: false, loading, disabled: false, error: '',
      onOpen: () => { opened++ }, onRemove: () => { removed++ }, onRetry() {} }}
  /></I18nProvider>)
  try {
    await act(async () => render())
    const editor = document.querySelector('.chat-input-editor')!
    assert.equal(editor.querySelectorAll('.composer-context-chip').length, 2)
    assert.equal(document.querySelector('.chat-input-toolbar .chat-role-binding-name'), null)
    assert.equal(editor.querySelector('textarea')!.value, '只发送用户正文')
    assert.ok(editor.querySelector('.composer-context-chip svg'))
    await act(async () => document.querySelector<HTMLButtonElement>('.chat-role-binding-name')!.click())
    assert.equal(opened, 1)
    await act(async () => document.querySelector<HTMLButtonElement>('.chat-input-send')!.click())
    assert.equal(sent, '只发送用户正文', 'visual labels never enter the message body')
    await act(async () => document.querySelector<HTMLButtonElement>('.connector-tag .composer-context-chip-remove')!.click())
    assert.deepEqual(selected, [])
    assert.equal(editor.querySelector('.connector-tag'), null)
    await act(async () => document.querySelector<HTMLButtonElement>('.chat-role-binding-remove')!.click())
    assert.equal(removed, 1)
    await act(async () => render(true))
    assert.ok(editor.querySelector('.composer-context-chip .task-status-spinner'))
    assert.equal(document.querySelector<HTMLButtonElement>('.chat-input-send')!.disabled, true)
  } finally {
    Object.assign(connectorApi, original); globalThis.fetch = oldFetch
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
