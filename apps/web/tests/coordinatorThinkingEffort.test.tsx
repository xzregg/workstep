import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import CoordinatorConfigBar from '../src/components/CoordinatorConfigBar'
import { I18nProvider } from '../src/i18n'

function installDom() {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    DOMRect: window.DOMRect,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    matchMedia: window.matchMedia.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  return window
}

test('empty thinking effort shows the inherited default level', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <CoordinatorConfigBar
            engines={[]}
            engine=""
            defaultEngine="codex_sdk"
            model=""
            fastModel=""
            thinkingEffort=""
            defaultThinkingEffort="low"
            onEngineChange={() => {}}
            onModelChange={() => {}}
            onFastModelChange={() => {}}
            onThinkingEffortChange={() => {}}
          />
        </I18nProvider>,
      )
    })

    assert.match(container.textContent || '', /默认（低）/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('auto thinking effort stays rendered as plain default', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <CoordinatorConfigBar
            engines={[]}
            engine=""
            defaultEngine="codex_sdk"
            model=""
            fastModel=""
            thinkingEffort=""
            defaultThinkingEffort="auto"
            onEngineChange={() => {}}
            onModelChange={() => {}}
            onFastModelChange={() => {}}
            onThinkingEffortChange={() => {}}
          />
        </I18nProvider>,
      )
    })

    assert.match(container.textContent || '', /默认/)
    assert.doesNotMatch(container.textContent || '', /默认（自动）/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
