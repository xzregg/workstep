import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import SkinStudio from '../src/components/SkinStudio'
import { I18nProvider } from '../src/i18n'
import { skinsApi } from '../src/api/skins'
import { defaultSkin, type SkinDocument } from '../src/skins/contract'
import { currentSkin, restoreDefaultSkin } from '../src/skins/runtime'
import { useChatSessionStore } from '../src/stores/chatSessionStore'
import { ApiError } from '../src/api/transport'
import { saveDraft } from '../src/utils/chatDraft'

test('manual controls edit the shared package, isolate preview, and protect dirty close and concurrent turns', async () => {
  const { window } = installDomEnvironment()
  Object.defineProperty(globalThis, 'history', { configurable: true, value: window.history })
  const oldFetch = globalThis.fetch, oldValidate = skinsApi.validate, oldSave = skinsApi.saveDraft
  restoreDefaultSkin()
  const skin: SkinDocument = { ...defaultSkin(), manifest: { ...defaultSkin().manifest, id: 'mine', name: '我的皮肤' }, revision: 'r1' }
  const result = (skin: SkinDocument) => ({ ok: true, skin, coverage: { overridden: [], inherited: [] }, visual_checked: false })
  skinsApi.validate = async () => result(skin)
  const saved: SkinDocument[] = []
  skinsApi.saveDraft = async (_path, revision, value) => { assert.equal(revision, 'r1'); saved.push(value); return result({ ...value, revision: 'r2' }) }
  globalThis.fetch = async input => {
    if (String(input).includes('/chat-sessions/old-session')) return Response.json({ id: 'old-session', project_id: 'design', title: '旧皮肤对话', messages: [{ id: 'old-message', role: 'user', content: '之前想要蓝色背景' }], running: false, engine: 'pydantic_ai' })
    if (String(input).includes('/chat-sessions/session')) return Response.json({ id: 'session', project_id: 'design', title: '', messages: [], running: false, engine: 'pydantic_ai' })
    if (String(input).includes('/chat-sessions?')) return Response.json({ sessions: [{ id: 'session', title: '当前设计' }, { id: 'old-session', title: '旧皮肤对话' }] })
    if (String(input).includes('/assistants')) return Response.json({ assistants: [{ name: 'chat_session', configured: {}, resolved: {}, available_engines: [] }] })
    return Response.json({ providers: [], buttons: [], runs: [], active_action_ids: [], sessions: [] })
  }
  let closed = 0
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><SkinStudio workspace={{ project_id: 'design', project_name: '皮肤设计', session_id: 'session', workspace_path: '/tmp/design', package_path: '/tmp/design/skin', prompt: '' }} onClose={() => { closed++ }} onSaved={() => {}} /></I18nProvider></MemoryRouter>))
    const history = document.querySelector<HTMLSelectElement>('.skin-studio-history select')!
    assert.equal(history.options.length, 2)
    await act(async () => { history.value = 'old-session'; history.dispatchEvent(new window.Event('change', { bubbles: true })) })
    assert.match(document.querySelector('.skin-studio-chat')!.textContent!, /之前想要蓝色背景/)
    await act(async () => { history.value = 'session'; history.dispatchEvent(new window.Event('change', { bubbles: true })) })
    await act(async () => document.querySelector<HTMLButtonElement>('.skin-studio-version button')!.click())
    assert.match(document.querySelector<HTMLTextAreaElement>('.skin-studio-chat textarea')!.value, /请继续调整「我的皮肤」/)
    const field = document.querySelector('.skin-studio-controls fieldset input:not([type])') as HTMLInputElement || document.querySelector('.skin-studio-controls fieldset input[type=text]') as HTMLInputElement
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field, '手动微调'); field.dispatchEvent(new window.Event('input', { bubbles: true })) })
    await act(async () => document.querySelector<HTMLButtonElement>('.skin-studio-palette button[aria-label="#7c65d5"]')!.click())
    assert.match(document.querySelector<HTMLIFrameElement>('.skin-studio-preview')!.srcdoc, /--accent:#7c65d5/)
    assert.equal(currentSkin().manifest.id, 'default')
    await act(async () => document.querySelector<HTMLButtonElement>('.skin-studio-header button')!.click())
    assert.equal(closed, 0)
    assert.ok(document.querySelector('.confirm-dialog-panel'))
    await act(async () => document.querySelector<HTMLButtonElement>('.confirm-dialog-footer button')!.click())
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '保存微调')!.click())
    assert.equal(saved[0].manifest.name, '手动微调')
    assert.equal(saved[0].tokens.accent, '#7c65d5')
    await act(async () => useChatSessionStore.setState(state => ({ sessions: { ...state.sessions, session: { ...state.sessions.session, running: true } } })))
    assert.equal(document.querySelector<HTMLFieldSetElement>('.skin-studio-controls fieldset')!.disabled, true)
  } finally {
    await act(async () => root.unmount()); skinsApi.validate = oldValidate; skinsApi.saveDraft = oldSave; globalThis.fetch = oldFetch
    useChatSessionStore.getState().resetSession('session'); useChatSessionStore.getState().resetSession('old-session'); await window.happyDOM.close()
  }
})

test('a new Runtime conversation can create its first skin before any package exists', async () => {
  const { window } = installDomEnvironment()
  Object.defineProperty(globalThis, 'history', { configurable: true, value: window.history })
  const oldFetch = globalThis.fetch, oldValidate = skinsApi.validate
  skinsApi.validate = async () => { throw new ApiError('尚未创建皮肤包', 404) }
  let sent = 0
  globalThis.fetch = async (input, init) => {
    const path = String(input)
    if (path.includes('/chat-sessions/empty-session/chat') && init?.method === 'POST') {
      sent++; return Response.json({ session_id: 'empty-session', turn_id: 'turn', assistant_message_id: 'reply', status: 'accepted' })
    }
    if (path.includes('/chat-sessions/empty-session')) return Response.json({ id: 'empty-session', project_id: 'design', title: '', messages: [], running: false, engine: 'pydantic_ai' })
    if (path.includes('/assistants')) return Response.json({ assistants: [{ name: 'chat_session', configured: { engine: 'pydantic_ai' }, resolved: {}, available_engines: [] }] })
    return Response.json({ providers: [], buttons: [], runs: [], active_action_ids: [], sessions: [] })
  }
  saveDraft('empty-session', '请在 Runtime 根目录创建我的皮肤包')
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><SkinStudio workspace={{ project_id: 'design', project_name: 'Runtime', session_id: 'empty-session', workspace_path: '/tmp/runtime', package_path: '/tmp/runtime/skin', prompt: '' }} onClose={() => {}} onSaved={() => {}} /></I18nProvider></MemoryRouter>))
    assert.ok(document.querySelector('.skin-studio-controls fieldset'), 'starting style is visible before a package is created')
    assert.ok(document.querySelector('.skin-studio-preview'))
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('.skin-studio-tabs [role=tab]')]
    assert.equal(tabs.length, 2)
    await act(async () => tabs[1].click())
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true')
    assert.equal(document.querySelector('.skin-studio')!.getAttribute('data-mobile-tab'), 'preview')
    await act(async () => tabs[0].click())
    const send = document.querySelector<HTMLButtonElement>('.skin-studio-chat .chat-input-send')!
    assert.equal(send.disabled, false)
    await act(async () => send.click())
    assert.equal(sent, 1)
  } finally {
    await act(async () => root.unmount()); skinsApi.validate = oldValidate; globalThis.fetch = oldFetch
    useChatSessionStore.getState().resetSession('empty-session'); await window.happyDOM.close()
  }
})
