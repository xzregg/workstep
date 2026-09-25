import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFile } from 'node:fs/promises'
import ProcessTrace from '../src/components/ProcessTrace'
import { I18nProvider } from '../src/i18n'

test('running process stays closed and previews only the latest two timeline items', async () => {
  const window = new Window({ width: 1280 })
  Object.assign(globalThis, {
    window, document: window.document, HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const startedAt = Date.now() - 2000
  const render = (events: object[], running = true) => root.render(
    <I18nProvider><ProcessTrace events={events as never} running={running} startedAt={startedAt} /></I18nProvider>,
  )
  const first = { type: 'REASONING_MESSAGE_CHUNK', delta: 'First thought' }
  const second = { type: 'TEXT_MESSAGE_CHUNK', delta: 'Answer text' }
  const third = { type: 'TOOL_CALL_START', toolCallId: 'read-1', toolCallName: 'Read latest' }
  const fourth = { type: 'TEXT_MESSAGE_CHUNK', phase: 'commentary', delta: 'Checking result' }
  try {
    await act(async () => render([]))
    const preview = container.querySelector<HTMLDivElement>('.process-trace-preview')!
    assert.ok(preview)
    assert.equal(preview.dataset.visible, undefined)
    assert.ok(container.querySelector('.process-trace-session-summary .is-shimmer'))

    await act(async () => render([first]))
    const session = container.querySelector<HTMLDivElement>('.process-trace-session')!
    assert.equal(container.querySelector('.process-trace-preview'), preview)
    assert.equal(preview.dataset.visible, 'true')
    assert.equal(session.dataset.open, undefined)
    assert.equal(container.querySelector('.process-trace-body'), null)
    assert.match(container.querySelector('.process-trace-preview')!.textContent!, /First thought/)
    assert.doesNotMatch(container.querySelector('.process-trace-preview')!.textContent!, /思考过程/)
    assert.equal(container.querySelectorAll('.process-trace-preview-item .is-shimmer').length, 0)

    await act(async () => render([first, second, third]))
    assert.equal(container.querySelectorAll('.process-trace-preview-item').length, 2)
    assert.match(container.querySelector('.process-trace-preview')!.textContent!, /First thought/)
    assert.doesNotMatch(container.querySelector('.process-trace-preview')!.textContent!, /Answer text/)
    assert.match(container.querySelector('.process-trace-preview')!.textContent!, /Read latest/)

    await act(async () => render([first, second, third, fourth]))
    assert.equal(container.querySelectorAll('.process-trace-preview-item').length, 2)
    assert.match(container.querySelector('.process-trace-preview')!.textContent!, /Read latest/)
    assert.match(container.querySelector('.process-trace-preview')!.textContent!, /Checking result/)
    assert.doesNotMatch(container.querySelector('.process-trace-preview')!.textContent!, /First thought/)

    const update = { ...fourth, delta: ' complete' }
    await act(async () => render([first, second, third, fourth, update]))
    assert.match(container.querySelector('.process-trace-preview')!.textContent!, /Checking result complete/)

    await act(async () => {
      container.querySelector<HTMLDivElement>('.process-trace-session-summary')!
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(session.dataset.open, 'true')
    assert.equal(container.querySelector('.process-trace-preview'), preview)
    assert.equal(preview.dataset.visible, undefined)
    assert.match(container.querySelector('.process-trace-body')!.textContent!, /First thought/)

    await act(async () => render([first, second, third, fourth, update], false))
    assert.equal(session.dataset.open, undefined)
    assert.equal(container.querySelector('.process-trace-preview'), null)
    assert.equal(container.querySelector('.process-trace-body'), null)

    await act(async () => {
      container.querySelector<HTMLDivElement>('.process-trace-session-summary')!
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    assert.match(container.querySelector('.process-trace-body')!.textContent!, /First thought/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('running preview stays at two compact rows on mobile', async () => {
  const window = new Window({ width: 390 })
  Object.assign(globalThis, {
    window, document: window.document, HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><ProcessTrace running events={[
      { type: 'thinking_delta', data: { delta: 'First' } },
      { type: 'TOOL_CALL_START', toolCallId: 'one', toolCallName: 'Read file' },
      { type: 'TOOL_CALL_START', toolCallId: 'two', toolCallName: 'Search files' },
      { type: 'TEXT_MESSAGE_CHUNK', phase: 'commentary', delta: 'Latest' },
    ]} /></I18nProvider>))
    assert.equal(container.querySelectorAll('.process-trace-preview-item').length, 2)
    assert.equal(container.querySelectorAll('.process-trace-preview-item .is-shimmer').length, 0)
    assert.match(container.querySelector('.process-trace-preview')!.textContent!, /Latest/)
    assert.doesNotMatch(container.querySelector('.process-trace-preview')!.textContent!, /First/)
    assert.equal(container.querySelector('.process-trace-body'), null)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('reclosing the process aligns the preview sweep with the title', async () => {
  const window = new Window({ width: 390 })
  Object.assign(globalThis, {
    window, document: window.document, HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><ProcessTrace running events={[
      { type: 'thinking_delta', data: { delta: 'Checking' } },
    ]} /></I18nProvider>))
    const summary = container.querySelector<HTMLDivElement>('.process-trace-session-summary')!
    const title = summary.querySelector<HTMLSpanElement>('.is-shimmer')!
    const preview = container.querySelector<HTMLDivElement>('.process-trace-preview')!
    const titleAnimation = { animationName: 'process-trace-shine', currentTime: 600 }
    const previewAnimation = { animationName: 'process-trace-shine', currentTime: 0 }
    Object.defineProperty(title, 'getAnimations', { value: () => [titleAnimation] })
    Object.defineProperty(preview, 'getAnimations', { value: () => [previewAnimation] })

    await act(async () => summary.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    assert.equal(preview.dataset.visible, undefined)
    await act(async () => summary.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    assert.equal(preview.dataset.visible, 'true')
    assert.equal(previewAnimation.currentTime, titleAnimation.currentTime)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('the collapsed preview animates as a container and respects reduced motion', async () => {
  const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')
  const titleAnimation = css.match(/\.process-trace-thinking-label\.is-shimmer\s*\{[^}]*animation:\s*process-trace-shine\s+([^;]+);/s)?.[1]
  const previewRule = css.match(/\.process-trace-preview\s*\{([^}]+)\}/s)?.[1] ?? ''
  const previewAnimation = previewRule.match(/animation:\s*process-trace-shine\s+([^;]+);/)?.[1]
  assert.ok(titleAnimation)
  assert.equal(previewAnimation, titleAnimation)
  assert.match(previewRule, /-webkit-mask-image:\s*linear-gradient/)
  assert.match(css, /@keyframes process-trace-shine\s*\{[^}]*-webkit-mask-position:/s)
  assert.match(css, /\.process-trace-preview:not\(\[data-visible\]\)\s*\{[^}]*visibility:\s*hidden/s)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.process-trace-preview\s*\{\s*animation:\s*none/s)
})
