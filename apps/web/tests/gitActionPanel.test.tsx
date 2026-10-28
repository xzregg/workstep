import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import GitActionPanel from '../src/components/git/GitActionPanel'

test('Git action panels escape clipping containers, clamp to the viewport and follow their anchor', async () => {
  const { window } = installDomEnvironment()
  window.innerWidth = 1280
  window.innerHeight = 800
  const original = window.HTMLElement.prototype.getBoundingClientRect
  let anchor = { left: 40, right: 100, top: 80, bottom: 112 }
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { ...(this.classList.contains('git-remote-panel') ? { left: 0, top: 0, right: 420, bottom: 400, width: 420, height: 400 } : { ...anchor, width: 60, height: 32 }), x: 0, y: 0, toJSON() {} }
  }
  const container = document.body.appendChild(document.createElement('div'))
  container.style.overflow = 'hidden'
  const root = createRoot(container)
  let closed = 0
  function Harness() {
    const ref = useRef<HTMLSpanElement>(null)
    return <span ref={ref}><button>Merge</button><GitActionPanel anchor={ref} label="Merge branch" onClose={() => closed++}><input /></GitActionPanel></span>
  }
  try {
    await act(async () => root.render(<Harness />))
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')!
    assert.ok(panel)
    assert.equal(container.contains(panel), false)
    assert.equal(panel.style.left, '16px')
    assert.equal(panel.style.top, '120px')
    await act(async () => panel.querySelector('input')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    assert.equal(closed, 0)
    anchor = { left: 1200, right: 1260, top: 700, bottom: 732 }
    await act(async () => window.dispatchEvent(new Event('resize')))
    assert.equal(panel.style.left, '840px')
    assert.equal(panel.style.top, '292px')
    anchor = { left: 600, right: 660, top: 100, bottom: 132 }
    await act(async () => window.dispatchEvent(new Event('scroll')))
    assert.equal(panel.style.left, '240px')
    assert.equal(panel.style.top, '140px')
    await act(async () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    assert.equal(closed, 1)
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(closed, 2)
  } finally {
    await act(async () => root.unmount())
    assert.equal(document.querySelector('[role="dialog"]'), null)
    window.HTMLElement.prototype.getBoundingClientRect = original
    container.remove()
    await window.happyDOM.close()
  }
})
