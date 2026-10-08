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

test('Codex selectors expose native efforts and preserve the selected value', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    for (const engine of ['codex_sdk', 'codex', 'claude']) {
      let selected = ''
      await act(async () => {
        root.render(
          <I18nProvider>
            <CoordinatorConfigBar
              engines={[]}
              engine=""
              defaultEngine={engine}
              model=""
              fastModel=""
              thinkingEffort=""
              defaultThinkingEffort={engine === 'claude' ? 'low' : 'ultra'}
              onEngineChange={() => {}}
              onModelChange={() => {}}
              onFastModelChange={() => {}}
              onThinkingEffortChange={(value) => { selected = value }}
            />
          </I18nProvider>,
        )
      })
      const select = Array.from(container.querySelectorAll('select')).find(
        (element) => Array.from(element.options).some((option) => option.value === 'xhigh'),
      )!
      assert.ok(select)
      assert.deepEqual(Array.from(select.options).map((option) => option.value), engine === 'claude'
        ? ['', 'auto', 'minimal', 'low', 'medium', 'high', 'xhigh']
        : ['', 'auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
      if (engine !== 'claude') {
        assert.match(select.options[0].textContent || '', /默认（超高）/)
        await act(async () => {
          select.value = 'ultra'
          select.dispatchEvent(new window.Event('change', { bubbles: true }))
        })
        assert.equal(selected, 'ultra')
      }
    }
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

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

test('auto thinking effort shows the inherited automatic level', async () => {
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

    assert.match(container.textContent || '', /默认（自动）/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
