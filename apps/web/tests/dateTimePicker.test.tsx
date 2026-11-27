import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import DateTimePicker from '../src/components/DateTimePicker'
import { I18nProvider } from '../src/i18n'

for (const width of [320, 390, 1023, 1024, 1440]) {
  test(`date time picker keyboard and dismissal at ${width}px`, async () => {
    const { window } = installDomEnvironment()
    window.innerWidth = width
    Object.assign(globalThis, { SVGElement: window.SVGElement, ShadowRoot: window.ShadowRoot,
      HTMLBodyElement: window.HTMLBodyElement, history: window.history,
      ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
    const viewport = new window.EventTarget()
    Object.assign(viewport, { height: 844, offsetTop: 0, scale: 1 })
    Object.defineProperty(window, 'visualViewport', { value: viewport })
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    const changes: string[] = []
    try {
      await act(async () => root.render(<I18nProvider><DateTimePicker
        value="2027-05-12T14:23:45" onChange={value => changes.push(value)}
      /></I18nProvider>))
      const input = container.querySelector('input')!
      assert.equal(input.readOnly, width <= 1023)
      await act(async () => input.click())
      assert.equal(Boolean(document.querySelector('.workstep-date-popup')), true)
      if (width <= 1023) {
        const cancel = document.querySelector<HTMLButtonElement>('.date-time-picker-cancel')!
        assert.equal(Boolean(cancel), true)
        assert.equal(document.body.style.overflow, 'hidden')
        await act(async () => {
          Object.assign(viewport, { height: 320, offsetTop: 24 })
          viewport.dispatchEvent(new window.Event('resize'))
        })
        const panel = document.querySelector<HTMLElement>('.date-time-picker-mobile-panel')!
        assert.equal(panel.style.maxHeight, '320px')
        assert.equal(panel.style.top, '24px')
        await act(async () => document.querySelector<HTMLElement>('td[title="2027-05-20"]')!.click())
        await act(async () => cancel.click())
        assert.deepEqual(changes, [])
        assert.equal(document.body.style.overflow, '')
      }
    } finally {
      await act(async () => root.unmount())
      container.remove()
      await window.happyDOM.close()
    }
  })
}

for (const precision of ['minute', 'second'] as const) {
  test(`calendar and time confirmation preserve ${precision} precision`, async () => {
    const { window } = installDomEnvironment()
    window.innerWidth = 390
    Object.assign(globalThis, { SVGElement: window.SVGElement, ShadowRoot: window.ShadowRoot,
      HTMLBodyElement: window.HTMLBodyElement, history: window.history,
      ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    const changes: string[] = []
    function Fixture() {
      const [value, setValue] = useState('2027-05-12T14:23:45')
      return <DateTimePicker value={value} min="2027-05-12T00:00:00" precision={precision} onChange={next => { changes.push(next); setValue(next) }} />
    }
    try {
      await act(async () => root.render(<I18nProvider><Fixture /></I18nProvider>))
      await act(async () => container.querySelector('input')!.click())
      assert.equal(document.querySelector('td[title="2027-05-10"]')!.classList.contains('ant-picker-cell-disabled'), true)
      await act(async () => document.querySelector<HTMLElement>('td[title="2027-05-20"]')!.click())
      for (const [index, value] of [15, 24, 42].entries()) {
        const column = document.querySelectorAll('.ant-picker-time-panel-column')[index]
        if (column) await act(async () => column.querySelector<HTMLElement>(`[data-value="${value}"]`)!.click())
      }
      assert.deepEqual(changes, [])
      await act(async () => document.querySelector<HTMLButtonElement>('.ant-picker-ok')!.click())
      assert.deepEqual(changes, [precision === 'minute' ? '2027-05-20T15:24:00' : '2027-05-20T15:24:42'])
      assert.equal(document.body.style.overflow, '')
    } finally {
      await act(async () => root.unmount())
      container.remove()
      await window.happyDOM.close()
    }
  })
}
