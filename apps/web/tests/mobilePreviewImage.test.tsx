import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import MobilePreviewImage from '../src/components/MobilePreviewImage'
import { installDomEnvironment } from './helpers/domEnv'

test('mobile image zooms at the tapped region, pinches, pans, cancels and resets for another image', async () => {
  const { window, document } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<MobilePreviewImage src="/a.png" alt="image" />))
    const viewport = document.querySelector<HTMLElement>('.image-preview-viewport')!
    viewport.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 }) as DOMRect
    const image = viewport.querySelector('img')!
    const pointer = async (type: string, id: number, x: number, y: number) => act(async () => {
      viewport.dispatchEvent(new window.PointerEvent(type, { bubbles: true, pointerId: id, pointerType: 'touch', clientX: x, clientY: y }))
    })
    await pointer('pointerdown', 1, 200, 100)
    await pointer('pointerup', 1, 200, 100)
    await pointer('pointerdown', 1, 200, 100)
    await pointer('pointerup', 1, 200, 100)
    assert.equal(image.style.transform, 'translate(-50px, 0px) scale(2)')
    await pointer('pointerdown', 1, 200, 100)
    await pointer('pointermove', 1, 900, 900)
    assert.equal(image.style.transform, 'translate(150px, 100px) scale(2)')
    await pointer('pointercancel', 1, 900, 900)
    await pointer('pointermove', 1, 0, 0)
    assert.equal(image.style.transform, 'translate(150px, 100px) scale(2)')
    await act(async () => root.render(<MobilePreviewImage src="/b.png" alt="image" />))
    assert.equal(image.style.transform, 'translate(0px, 0px) scale(1)')
    await pointer('pointerdown', 1, 100, 100)
    await pointer('pointerdown', 2, 200, 100)
    await pointer('pointermove', 2, 300, 100)
    assert.match(image.style.transform, /scale\(2\)/)
    await pointer('pointerup', 2, 300, 100)
    await pointer('pointermove', 1, 120, 100)
    assert.match(image.style.transform, /scale\(2\)/)
    await pointer('pointerup', 1, 120, 100)
    await pointer('pointerdown', 1, 150, 100)
    await pointer('pointerup', 1, 150, 100)
    await pointer('pointerdown', 1, 150, 100)
    await pointer('pointerup', 1, 150, 100)
    assert.equal(image.style.transform, 'translate(0px, 0px) scale(1)')
    // Some WebViews synthesize dblclick after touch taps; do not toggle twice.
    await act(async () => viewport.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, clientX: 150, clientY: 100 })))
    assert.equal(image.style.transform, 'translate(0px, 0px) scale(1)')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
