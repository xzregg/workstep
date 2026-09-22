import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import FlowCanvas from '../src/components/FlowCanvas'
import { I18nProvider } from '../src/i18n'

function installDom() {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    fetch: async () => new Response(JSON.stringify({
      engines: [], templates: [], resolved_engine: 'pydantic_ai',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  return window
}

test('step cards give long titles enough room to wrap without truncation', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const title = '需求评估 常规 PRD 四件套产出'

  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <ReactFlowProvider>
            <FlowCanvas
              initialSteps={{ steps: [{ key: 'prd', label: title, engine: 'pydantic_ai' }] }}
              onSave={() => {}}
            />
          </ReactFlowProvider>
        </I18nProvider>,
      )
    })

    const titleElement = Array.from(container.querySelectorAll('span'))
      .find((element) => element.textContent === title) as HTMLSpanElement | undefined
    assert.ok(titleElement)
    assert.equal(titleElement.style.whiteSpace, 'normal')
    assert.equal(titleElement.style.overflowWrap, 'anywhere')
    assert.equal(titleElement.parentElement?.parentElement?.style.width, '280px')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
