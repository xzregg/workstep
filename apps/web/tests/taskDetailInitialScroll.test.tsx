import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import TaskDetailView from '../src/components/TaskDetailView'

// History can arrive before the task record, while the transcript DOM is absent.
for (const width of [1440, 390, 320]) {
test(`task details follow after delayed mount, reopen and task switch, but preserve manual history browsing (${width}px)`, async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width, height: 844 })
  let height = 1500
  const previousObserver = globalThis.ResizeObserver
  const resizeCallbacks = new Set<() => void>()
  globalThis.ResizeObserver = class {
    callback: () => void
    constructor(callback: () => void) { this.callback = callback }
    observe(node: Element) {
      if (node.classList.contains('task-conversation-content')) resizeCallbacks.add(this.callback)
    }
    unobserve() {}
    disconnect() { resizeCallbacks.delete(this.callback) }
  } as unknown as typeof ResizeObserver
  Object.defineProperties(window.HTMLElement.prototype, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => 300 },
  })
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const step = { key: 'do', label: '执行', color: 'blue', prompt: '', inputs: [], outputs: [] }
  const historyMessages: any[] = []
  const liveMessages = {}
  const events: any[] = []
  const render = (id: string | null, opened = true) => act(async () => root.render(opened ? <I18nProvider><TaskDetailView
    locale='zh-CN' durationNowMs={Date.now()} currentStep={step} activeStep={step}
    currentStepColor='blue' activeStepColor='blue' taskCompleted={false}
    runningSteps={[]} executionStepModel='' sessionIdForStep={() => null} onViewingPromptChange={() => {}}
    task={id ? { id, title: '任务标题', status: 'ready', steps: [], created_at: '2026-01-01T00:00:00Z' } : null}
    steps={[step]} stepProgress={[]} selectedStep={0} onStepClick={() => {}}
    historyMessages={historyMessages} liveMessages={liveMessages} events={events} content=''
    reviews={[]} artifacts={[]} chatEnabled={false}
  /></I18nProvider> : null))
  const viewport = () => host.querySelector<HTMLElement>('.task-chat-history-scroll')!
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 650)) })
  try {
    await render(null)
    await render('first')
    await settle()
    assert.equal(viewport().scrollTop, 1200, 'history already loaded before task record')
    // Media loads after mounting must retain bottom following.
    height = 1800
    await act(async () => viewport().dispatchEvent(new window.Event('load')))
    await settle()
    assert.equal(viewport().scrollTop, 1500)
    // Markdown expansion and other layout changes do not change message data.
    height = 2100
    await act(async () => resizeCallbacks.forEach(callback => callback()))
    await settle()
    assert.equal(viewport().scrollTop, 1800)
    await act(async () => {
      if (width > 1023) {
        viewport().dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, deltaY: -100 }))
      } else {
        // Finger movement toward the bottom of the screen reveals older messages.
        viewport().dispatchEvent(new window.TouchEvent('touchstart', { touches: [{ clientY: 100 }] as any }))
        viewport().dispatchEvent(new window.TouchEvent('touchmove', { touches: [{ clientY: 200 }] as any }))
      }
    })
    viewport().scrollTop = 200
    await render('first')
    await act(async () => viewport().dispatchEvent(new window.Event('load')))
    await settle()
    assert.equal(viewport().scrollTop, 200, 'ordinary renders and media preserve manual scrolling')
    await render('second')
    await settle()
    assert.equal(viewport().scrollTop, 1800, 'switching tasks resets following')
    if (width <= 1023) {
      const tabs = host.querySelectorAll<HTMLButtonElement>('.mobile-detail-tabs [role=tab]')
      assert.equal(tabs.length, 3, 'the production mobile layout is active')
      await act(async () => tabs[1].click())
      assert.equal(tabs[1].getAttribute('aria-selected'), 'true')
      await render('third')
      await act(async () => tabs[0].click())
      assert.equal(viewport().scrollTop, 1800, 'returning from mobile steps follows the selected task')
    }
    await render(null, false)
    await render('second')
    await settle()
    assert.equal(viewport().scrollTop, 1800, 'reopening starts at the end')
    for (height of [200, 0]) {
      await render(null, false)
      await render('short')
      assert.equal(viewport().scrollTop, 0)
    }
  } finally {
    await act(async () => root.unmount())
    host.remove()
    globalThis.ResizeObserver = previousObserver
    await window.happyDOM.close()
  }
})
}
