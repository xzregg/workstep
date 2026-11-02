import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import QuickPromptOverflow from '../src/components/QuickPromptOverflow'
import { I18nProvider } from '../src/i18n'

test('shortcuts fold into a card, select once and close with Escape or outside click', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let selected = 0
  try {
    await act(async () => root.render(<I18nProvider><QuickPromptOverflow label="快捷按钮" items={Array.from({ length: 7 }, (_, i) =>
      <button key={i} disabled={i === 6} onClick={() => selected++}>操作{i}</button>,
    )} /></I18nProvider>))
    assert.equal(container.querySelectorAll('[data-overflow="false"]').length, 5)
    const more = container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!
    await act(async () => more.click())
    let card = document.querySelector<HTMLElement>('.quick-prompt-overflow-card')!
    assert.ok(card)
    assert.deepEqual([...card.querySelectorAll('button')].map(b => b.textContent), ['操作5', '操作6'])
    assert.equal(card.querySelectorAll('button')[1].disabled, true)
    await act(async () => card.querySelector('button')!.click())
    assert.equal(selected, 1)
    assert.equal(document.querySelector('.quick-prompt-overflow-card'), null)
    await act(async () => more.click())
    await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })))
    assert.equal(document.querySelector('.quick-prompt-overflow-card'), null)
    await act(async () => more.click())
    await act(async () => document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })))
    assert.equal(document.querySelector('.quick-prompt-overflow-card'), null)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('shortcuts remeasure narrower and wider rows while reserving the more button', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let width = 280
  const prototype = window.HTMLElement.prototype
  const clientWidth = Object.getOwnPropertyDescriptor(prototype, 'clientWidth')
  const offsetWidth = Object.getOwnPropertyDescriptor(prototype, 'offsetWidth')
  Object.defineProperty(prototype, 'clientWidth', { configurable: true, get() { return width } })
  Object.defineProperty(prototype, 'offsetWidth', { configurable: true, get() { return 80 } })
  try {
    await act(async () => root.render(<I18nProvider><QuickPromptOverflow items={Array.from({ length: 6 }, (_, i) => <button key={i}>操作{i}</button>)} /></I18nProvider>))
    assert.equal(container.querySelectorAll('[data-overflow="false"]').length, 2)
    width = 190
    await act(async () => window.dispatchEvent(new window.Event('resize')))
    assert.equal(container.querySelectorAll('[data-overflow="false"]').length, 1)
    width = 900
    await act(async () => window.dispatchEvent(new window.Event('resize')))
    assert.equal(container.querySelectorAll('[data-overflow="false"]').length, 5)
  } finally {
    await act(async () => root.unmount())
    if (clientWidth) Object.defineProperty(prototype, 'clientWidth', clientWidth)
    else Reflect.deleteProperty(prototype, 'clientWidth')
    if (offsetWidth) Object.defineProperty(prototype, 'offsetWidth', offsetWidth)
    else Reflect.deleteProperty(prototype, 'offsetWidth')
    container.remove()
    await window.happyDOM.close()
  }
})
