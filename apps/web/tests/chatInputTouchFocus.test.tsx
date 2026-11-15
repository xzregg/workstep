import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ChatInput from '../src/components/ChatInput'
import { I18nProvider } from '../src/i18n'

test('composer whitespace taps restore focus without a synthetic click after scrolling', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const touch = (target: Element, type: string, y = 20) => {
    const event = new window.Event(type, { bubbles: true })
    Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientX: 20, clientY: y }] })
    Object.defineProperty(event, 'changedTouches', { value: [{ clientX: 20, clientY: y }] })
    target.dispatchEvent(event)
  }
  try {
    await act(async () => root.render(<I18nProvider><ChatInput value="草稿" onChange={() => {}} onSend={() => {}} /></I18nProvider>))
    const editor = document.querySelector('.chat-input-editor')!
    const input = document.querySelector('textarea')!
    for (let attempt = 0; attempt < 3; attempt++) {
      await act(async () => {
        input.blur()
        window.dispatchEvent(new window.Event('scroll'))
        touch(editor, 'touchstart')
        touch(editor, 'touchend')
      })
      assert.ok(document.activeElement === input, 'tap focuses the textarea')
      assert.equal(input.value, '草稿')
    }
    await act(async () => {
      input.blur()
      touch(editor, 'touchstart')
      touch(editor, 'touchmove', 70)
      touch(editor, 'touchend')
    })
    assert.ok(document.activeElement !== input, 'scrolling the composer must not open the keyboard')
    await act(async () => {
      touch(editor, 'touchstart')
      touch(editor, 'touchcancel')
      touch(editor, 'touchend')
    })
    assert.ok(document.activeElement !== input, 'cancelled gestures must not focus')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
