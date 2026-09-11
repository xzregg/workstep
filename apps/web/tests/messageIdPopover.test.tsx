import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import MessageMetaBar from '../src/components/MessageMetaBar'
import { I18nProvider } from '../src/i18n'
import { useUserSettingsStore } from '../src/stores/userSettingsStore'

function setup() {
  const window = new Window()
  const written: string[] = []
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: { ...globalThis.navigator, clipboard: { writeText: (value: string) => { written.push(value); return Promise.resolve() } } },
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  return { window, root, written }
}

function render(root: ReturnType<typeof createRoot>, node: React.ReactNode) {
  return act(async () => {
    root.render(<I18nProvider>{node}</I18nProvider>)
  })
}

test('session id trigger opens a dropdown panel with session and message ids', async () => {
  const { window, root, written } = setup()
  await render(root, (
    <MessageMetaBar
      sessionId="sess-fedcba0987654321"
      messageId="msg-1234567890abcdef"
      prompt="hi"
      onViewPrompt={() => {}}
    />
  ))
  const trigger = window.document.querySelector('.msg-id-trigger')
  assert.ok(trigger, 'trigger rendered')
  // Panel hidden until the entry is activated.
  assert.equal(window.document.querySelector('.msg-id-popover'), null)
  // Clicking the「会話 ID」entry opens the panel (does NOT copy the session id).
  const labelButton = trigger!.querySelector('button')!
  await act(async () => { labelButton.dispatchEvent(new window.Event('click', { bubbles: true })) })
  assert.equal(written.length, 0, 'clicking label must not copy')
  const popover = window.document.querySelector('.msg-id-popover')
  assert.ok(popover, 'panel opened')
  const rows = popover!.querySelectorAll('.msg-id-row')
  assert.equal(rows.length, 2)
  assert.match(rows[0].textContent!, /sess-fedcba0987654321/)
  assert.match(rows[1].textContent!, /msg-1234567890abcdef/)
  const copyButtons = popover!.querySelectorAll('button')
  assert.equal(copyButtons.length, 2)
  await act(async () => { copyButtons[0].dispatchEvent(new window.Event('click', { bubbles: true })) })
  assert.deepEqual(written, ['sess-fedcba0987654321'])
  await act(async () => { copyButtons[1].dispatchEvent(new window.Event('click', { bubbles: true })) })
  assert.deepEqual(written, ['sess-fedcba0987654321', 'msg-1234567890abcdef'])
  await act(async () => { root.unmount() })
  await window.happyDOM.close()
})

test('panel omits the message row when there is no message id', async () => {
  const { window, root } = setup()
  await render(root, (
    <MessageMetaBar sessionId="sess-only" prompt="hi" onViewPrompt={() => {}} />
  ))
  const labelButton = window.document.querySelector('.msg-id-trigger button')!
  await act(async () => { labelButton.dispatchEvent(new window.Event('click', { bubbles: true })) })
  const popover = window.document.querySelector('.msg-id-popover')!
  assert.ok(popover)
  assert.equal(popover.querySelectorAll('.msg-id-row').length, 1)
  assert.match(popover.textContent!, /sess-only/)
  await act(async () => { root.unmount() })
  await window.happyDOM.close()
})

test('no session id and no message id renders no trigger', async () => {
  const { window, root } = setup()
  await render(root, <MessageMetaBar prompt="hi" onViewPrompt={() => {}} />)
  assert.equal(window.document.querySelector('.msg-id-trigger'), null)
  assert.equal(window.document.querySelector('.msg-id-popover'), null)
  await act(async () => { root.unmount() })
  await window.happyDOM.close()
})

test('chat message bubble no longer renders inline id chips', async () => {
  // Regression: ids must only appear inside the「会話 ID」dropdown panel,
  // never as a standalone row under the message.
  const { window, root } = setup()
  await render(root, (
    <MessageMetaBar sessionId="sess-x" messageId="msg-x" prompt="hi" onViewPrompt={() => {}} />
  ))
  assert.equal(window.document.querySelector('.msg-id-inline'), null)
  await act(async () => { root.unmount() })
  await window.happyDOM.close()
})

test('developer mode adds an open-journal button beside each copy button', async () => {
  useUserSettingsStore.setState({ openMode: true })
  const calls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return { ok: true, json: async () => ({ opened: true, path: '/tmp/x' }) }
  }) as typeof fetch
  try {
    const { window, root } = setup()
    await render(root, (
      <MessageMetaBar
        sessionId="sess-dev"
        messageId="msg-dev"
        projectId="project-1"
        prompt="hi"
        onViewPrompt={() => {}}
      />
    ))
    const labelButton = window.document.querySelector('.msg-id-trigger button')!
    await act(async () => { labelButton.dispatchEvent(new window.Event('click', { bubbles: true })) })
    const popover = window.document.querySelector('.msg-id-popover')!
    const openButtons = popover.querySelectorAll('.msg-id-open')
    assert.equal(openButtons.length, 2, 'session + message rows both get an open button')
    await act(async () => {
      openButtons[0].dispatchEvent(new window.Event('click', { bubbles: true }))
    })
    assert.deepEqual(calls, ['/api/fs/open-session-journal'])
    // Feedback: the button flips to a success (check) state, then resets.
    assert.match(
      openButtons[0].querySelector('svg')!.getAttribute('class') || '',
      /lucide-check/,
    )
    await act(async () => { root.unmount() })
    await window.happyDOM.close()
  } finally {
    globalThis.fetch = originalFetch
    useUserSettingsStore.setState({ openMode: false })
  }
})

test('open-journal button is hidden without developer mode', async () => {
  const { window, root } = setup()
  await render(root, (
    <MessageMetaBar
      sessionId="sess-dev"
      messageId="msg-dev"
      projectId="project-1"
      prompt="hi"
      onViewPrompt={() => {}}
    />
  ))
  const labelButton = window.document.querySelector('.msg-id-trigger button')!
  await act(async () => { labelButton.dispatchEvent(new window.Event('click', { bubbles: true })) })
  const popover = window.document.querySelector('.msg-id-popover')!
  assert.equal(popover.querySelectorAll('.msg-id-open').length, 0)
  await act(async () => { root.unmount() })
  await window.happyDOM.close()
})
