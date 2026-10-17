import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useChatComposerResize } from '../src/hooks/useChatComposerResize'
import { applySkin } from '../src/skins/runtime'
import { defaultSkin } from '../src/skins/contract'

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
    <div ref={resize.composerRef} data-height={resize.height ?? 'auto'} data-position={resize.position}>
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

test('left/right composer resizing uses width, preserves the mounted draft and separates saved dimensions', async () => {
  const { window } = installDomEnvironment()
  // Desktop layout for the position under test.
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const skin = { ...defaultSkin(), manifest: { ...defaultSkin().manifest, id: 'layout' }, layout: { composerPosition: 'left' as const } }
  const originalRect = window.HTMLElement.prototype.getBoundingClientRect
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const width = this.hasAttribute('data-height') ? 300 : 1000
    return { height: 500, width, left: 0, right: width, top: 0, bottom: 500 } as DOMRect
  }
  try {
    applySkin(skin)
    await act(async () => root.render(<ComposerHarness />))
    const composer = host.querySelector('[data-height]') as HTMLElement
    const separator = host.querySelector('[role="separator"]')!
    assert.equal(composer.dataset.position, 'left')
    await act(async () => separator.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    assert.equal(window.localStorage.getItem('workstep-chat-composer-width'), '308')
    assert.equal(window.localStorage.getItem('workstep-chat-composer-height'), null)
    await act(async () => applySkin({ ...skin, layout: { composerPosition: 'right' } }))
    assert.equal(host.querySelector('[data-height]'), composer)
    assert.equal(composer.dataset.position, 'right')
    await act(async () => separator.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    assert.equal(window.localStorage.getItem('workstep-chat-composer-width'), '308')
  } finally {
    window.HTMLElement.prototype.getBoundingClientRect = originalRect
    await act(async () => root.unmount())
    applySkin(defaultSkin())
    await window.happyDOM.close()
  }
})
