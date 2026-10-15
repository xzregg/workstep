import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import ResponsiveNavigation from '../src/components/ResponsiveNavigation'
import { I18nProvider } from '../src/i18n'
import { installDomEnvironment } from './helpers/domEnv'

for (const [width, android, visible] of [[390, false, true], [320, false, true], [1023, false, true], [1280, false, false], [390, true, false]] as const) {
  test(`navigation float at ${width}px, Android=${android}`, async () => {
    const { window, document } = installDomEnvironment()
    window.innerWidth = width
    const styles = document.head.appendChild(document.createElement('style'))
    styles.textContent = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8') + readFileSync(new URL('../src/components/MobileNavigationFloat.css', import.meta.url), 'utf8')
    const oldHistory = globalThis.history
    globalThis.history = window.history as unknown as History
    if (android) Object.defineProperty(window, 'WorkStepAndroid', { value: {}, configurable: true })
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    try {
      await act(async () => root.render(<I18nProvider><MemoryRouter><ResponsiveNavigation title="WorkStep" onNew={() => {}}><button>项目</button></ResponsiveNavigation></MemoryRouter></I18nProvider>))
      const button = document.querySelector<HTMLButtonElement>('.mobile-navigation-float')
      assert.equal(!!button, visible)
      if (android) {
        // MainActivity's native circle uses these selectors to toggle the drawer.
        const nativeCircleTap = () => {
          const open = document.querySelector<HTMLButtonElement>('button[aria-controls="workstep-navigation"]')!
          const close = document.getElementById('workstep-navigation')!.querySelector<HTMLButtonElement>('button.navigation-close')!
          if (open.getAttribute('aria-expanded') === 'true') close.click()
          else open.click()
        }
        await act(async () => nativeCircleTap())
        assert.ok(container.querySelector('aside.is-open'))
        await act(async () => nativeCircleTap())
        assert.equal(container.querySelector('aside.is-open'), null)
      }
      if (button) {
        assert.equal(button.getAttribute('aria-controls'), 'workstep-navigation')
        const transition = window.getComputedStyle(button).transition
        assert.match(transition, /background/)
        assert.doesNotMatch(transition, /all|transform|left|top/, 'drag position must never animate')
        await act(async () => button.click())
        assert.ok(container.querySelector('aside.is-open'))
        assert.equal(container.querySelectorAll('aside').length, 1)
        await act(async () => button.click())
        assert.equal(container.querySelector('aside.is-open'), null)
        let measurements = 0
        button.getBoundingClientRect = () => { measurements++; return { left: 100, top: 100, width: 44, height: 44 } as DOMRect }
        let frames = 0
        const scheduled = new Map<number, FrameRequestCallback>()
        window.requestAnimationFrame = callback => { scheduled.set(++frames, callback); return frames }
        window.cancelAnimationFrame = id => { scheduled.delete(id) }
        await act(async () => {
          button.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerId: 1, isPrimary: true, clientX: 300, clientY: 500 }))
          button.dispatchEvent(new window.PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, clientX: 900, clientY: 500 }))
          button.dispatchEvent(new window.PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 850, clientY: 480 }))
          assert.equal(measurements, 1, 'measure the button once per gesture')
          assert.equal(frames, 1, 'coalesce pointer moves into one animation frame')
          button.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))
          assert.equal(scheduled.size, 0, 'release flushes the latest position and cancels pending paint')
          button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 }))
        })
        assert.equal(container.querySelector('aside.is-open'), null, 'drag must not open navigation')
        assert.ok(parseFloat(button.style.getPropertyValue('--float-x')) <= width - 44)
        const left = button.style.getPropertyValue('--float-x')
        await act(async () => button.dispatchEvent(new window.PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 50, clientY: 100 })))
        assert.equal(button.style.getPropertyValue('--float-x'), left, 'released pointer must no longer move the float')
        await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 0 })))
        assert.ok(container.querySelector('aside.is-open'), 'keyboard activation works after dragging')
      }
    } finally {
      await act(async () => root.unmount())
      globalThis.history = oldHistory
      await window.happyDOM.close()
    }
  })
}
