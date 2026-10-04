import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useChatComposerResize } from '../src/hooks/useChatComposerResize'

function ComposerHarness() {
  const resize = useChatComposerResize()
  return <div ref={resize.rootRef}>
    <div
      role="separator"
      tabIndex={0}
      onMouseDown={resize.startResize}
      onDoubleClick={resize.resetHeight}
      onKeyDown={resize.handleResizeKey}
    />
    <div ref={resize.composerRef} data-height={resize.height ?? 'auto'}>
      <div ref={resize.composerInnerRef} />
    </div>
  </div>
}

test('composer resize restores, clamps, persists and resets its height', async () => {
  const { window } = installDomEnvironment()
  window.localStorage.setItem('workstep-chat-composer-height', '320')
  const container = window.document.body.appendChild(window.document.createElement('div'))
  const root = createRoot(container as never)
  const originalRect = window.HTMLElement.prototype.getBoundingClientRect
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const height = this.hasAttribute('data-height') ? 320 : 400
    return { height, top: 0, bottom: height, width: 400, left: 0, right: 400 } as DOMRect
  }
  try {
    await act(async () => root.render(<ComposerHarness />))
    const separator = container.querySelector('[role="separator"]') as HTMLElement
    const composer = container.querySelector('[data-height]') as HTMLElement
    assert.equal(composer.dataset.height, '320')

    await act(async () => separator.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'ArrowUp', bubbles: true,
    })))
    assert.equal(composer.dataset.height, '328')
    assert.equal(window.localStorage.getItem('workstep-chat-composer-height'), '328')

    await act(async () => separator.dispatchEvent(new window.MouseEvent('mousedown', {
      clientY: 100, bubbles: true,
    })))
    await act(async () => window.dispatchEvent(new window.MouseEvent('mousemove', {
      clientY: 20, bubbles: true,
    })))
    await act(async () => window.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true })))
    assert.equal(composer.dataset.height, '340')
    assert.equal(window.localStorage.getItem('workstep-chat-composer-height'), '340')

    await act(async () => separator.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })))
    assert.equal(composer.dataset.height, 'auto')
    assert.equal(window.localStorage.getItem('workstep-chat-composer-height'), null)
  } finally {
    window.HTMLElement.prototype.getBoundingClientRect = originalRect
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
