import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import RobotAvatar from '../src/components/RobotAvatar'
import ChatMessageBubble from '../src/components/ChatMessageBubble'
import AssistantThinkingMessage from '../src/components/AssistantThinkingMessage'
import { I18nProvider } from '../src/i18n'

test('thinking placeholders preserve task avatars by default and opt in for assistant chats', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    for (const animatedAvatar of [false, true]) {
      await act(async () => root.render(<I18nProvider><AssistantThinkingMessage
        sender="助手" initials="阶段" animatedAvatar={animatedAvatar}
      /></I18nProvider>))
      assert.equal(!!document.querySelector('.robot-avatar'), animatedAvatar)
      if (!animatedAvatar) assert.equal(document.querySelector('.chat-message-avatar')?.textContent, '阶段')
    }
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

test('avatar morphs in place, retargets continuously, stops after completion and cleans up', async () => {
  const { window } = installDomEnvironment()
  const frames = new Map<number, FrameRequestCallback>()
  let now = 0
  let id = 0
  window.requestAnimationFrame = callback => { frames.set(++id, callback); return id }
  window.cancelAnimationFrame = key => { frames.delete(key) }
  Object.defineProperty(window, 'performance', { value: { now: () => now } })
  window.IntersectionObserver = class {
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe() { this.callback([{ isIntersecting: true }]) }
    disconnect() {}
  } as never
  const advance = (ms: number) => { now += ms; const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now)) }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<RobotAvatar state="thinking" />))
    const svg = document.querySelector('svg')!
    const eye = svg.querySelector('[data-feature="leftEye"]')!
    const original = eye.getAttribute('d')
    await act(async () => root.render(<RobotAvatar state="done" />))
    assert.equal(document.querySelector('svg'), svg)
    assert.equal(eye.getAttribute('d'), original)
    advance(140)
    const middle = eye.getAttribute('d')
    assert.notEqual(middle, original)
    await act(async () => root.render(<RobotAvatar state="stopped" />))
    assert.equal(eye.getAttribute('d'), middle)
    advance(300)
    assert.equal(frames.size, 0)
    await act(async () => root.render(<RobotAvatar state="working" />))
    assert.equal(frames.size, 1)
    await act(async () => root.unmount())
    assert.equal(frames.size, 0)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

test('offscreen, hidden-tab and reduced-motion avatars do not keep frame loops alive', async () => {
  const { window } = installDomEnvironment()
  const frames = new Map<number, FrameRequestCallback>()
  let id = 0
  window.requestAnimationFrame = callback => { frames.set(++id, callback); return id }
  window.cancelAnimationFrame = key => { frames.delete(key) }
  let intersection: (entries: { isIntersecting: boolean }[]) => void = () => {}
  let disconnected = false
  window.IntersectionObserver = class {
    constructor(callback: typeof intersection) { intersection = callback }
    observe() {}
    disconnect() { disconnected = true }
  } as never
  const preference = new window.EventTarget() as unknown as MediaQueryList
  let reduced = false
  Object.defineProperty(preference, 'matches', { get: () => reduced })
  window.matchMedia = () => preference as never
  let hidden = false
  Object.defineProperty(document, 'hidden', { get: () => hidden })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<RobotAvatar state="working" />))
    assert.equal(frames.size, 0, 'offscreen starts static')
    intersection([{ isIntersecting: true }])
    assert.equal(frames.size, 1)
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    assert.equal(frames.size, 0)
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    assert.equal(frames.size, 1)
    reduced = true
    preference.dispatchEvent(new Event('change'))
    assert.equal(frames.size, 0)
    await act(async () => root.render(<RobotAvatar state="done" />))
    assert.equal(frames.size, 0)
    assert.equal(document.querySelector('[data-feature="leftEye"]')?.getAttribute('d'), 'M10.5 16Q12 13 13.5 16')
    reduced = false
    preference.dispatchEvent(new Event('change'))
    assert.equal(frames.size, 0, 'completed history stays static')
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
  assert.equal(disconnected, true)
  assert.equal(frames.size, 0)
})

test('shared bubble keeps human identity and displays waiting even for read-only viewers; explicit stop wins', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const events = [{ type: 'CUSTOM', name: 'workstep.interaction_request', value: { interaction_id: 'p', method: 'session/request_permission', tool_call: { title: 'Bash' } } }]
  const render = (role: 'user' | 'assistant', streaming: boolean, status?: 'stopped') => root.render(
    <I18nProvider><ChatMessageBubble animatedAvatar role={role} sender="小明" initials="明" color="purple" content="" streaming={streaming} status={status} events={events} interactionsEnabled={false} /></I18nProvider>,
  )
  try {
    await act(async () => render('user', false))
    assert.equal(document.querySelector('.robot-avatar'), null)
    assert.ok(document.querySelector('.chat-message-avatar-anchor')?.textContent?.includes('明'))
    await act(async () => render('assistant', true))
    assert.equal(document.querySelector('.robot-avatar')?.getAttribute('data-state'), 'waiting')
    await act(async () => render('assistant', false, 'stopped'))
    assert.equal(document.querySelector('.robot-avatar')?.getAttribute('data-state'), 'stopped')
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})
