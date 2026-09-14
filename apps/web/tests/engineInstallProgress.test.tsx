import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import EngineInstallProgress from '../src/components/EngineInstallProgress.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'

test('estimated progress grows, caps below completion, and resets on retry', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] })
  const window = new Window()
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  const render = async (active: boolean, completed = false) => {
    await act(async () => root.render(
      <I18nProvider><EngineInstallProgress active={active} completed={completed} label="正在安装 Codex…" /></I18nProvider>,
    ))
  }
  const value = () => Number(window.document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'))
  try {
    await render(true)
    assert.equal(value(), 0)
    assert.equal(window.document.querySelector('.engine-install-progress-value')?.textContent, '0%')
    assert.doesNotMatch(window.document.body.textContent, /预估/)
    await act(async () => context.mock.timers.tick(2000))
    assert.ok(value() > 0)
    for (let i = 0; i < 200; i++) await act(async () => context.mock.timers.tick(2000))
    assert.equal(value(), 95)
    await render(false)
    assert.equal(window.document.querySelector('[role="progressbar"]'), null)
    await render(true)
    assert.equal(value(), 0)
    await render(false, true)
    assert.equal(value(), 100)
    assert.doesNotMatch(window.document.body.textContent, /预估/)
    assert.equal(window.document.querySelector('.spinner'), null)
    await act(async () => context.mock.timers.tick(20000))
    assert.equal(value(), 100)
  } finally {
    await act(async () => root.unmount())
    context.mock.timers.reset()
  }
})

test('installation removes progress feedback once the request has settled', () => {
  assert.equal(renderToStaticMarkup(
    <I18nProvider><EngineInstallProgress active={false} label="正在安装 Codex…" /></I18nProvider>,
  ), '')
})
