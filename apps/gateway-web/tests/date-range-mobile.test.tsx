import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { GatewayDateRangePicker } from '../src/GatewayDateRangePicker'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://gateway.test' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, SVGElement: dom.window.SVGElement,
  ShadowRoot: dom.window.ShadowRoot, getComputedStyle: dom.window.getComputedStyle,
  MutationObserver: dom.window.MutationObserver })
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {} } as any)
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
const { render, cleanup, act } = await import('@testing-library/react')

test('date ranges avoid mobile keyboards and retain desktop typing after resizing', async () => {
  Object.defineProperty(window, 'innerWidth', { value: 390, writable: true })
  const view = render(<GatewayDateRangePicker from="2027-05-12T14:23:00Z" to="2027-05-13T14:23:00Z" onChange={() => {}} />)
  try {
    assert.deepEqual([...view.container.querySelectorAll('input')].map(input => input.readOnly), [true, true])
    await act(async () => {
      window.innerWidth = 1440
      window.dispatchEvent(new dom.window.Event('resize'))
    })
    assert.deepEqual([...view.container.querySelectorAll('input')].map(input => input.readOnly), [false, false])
  } finally {
    cleanup()
  }
})
