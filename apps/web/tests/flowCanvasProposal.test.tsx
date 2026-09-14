import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import FlowCanvas, { type FlowCanvasHandle } from '../src/components/FlowCanvas'
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
      engines: [], templates: [], resolved_engine: 'claude',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  return window
}

test('renders an applied AI proposal that uses the historical assistant shape', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const canvasRef = createRef<FlowCanvasHandle>()
  const proposal = {
    nodes: [
      { id: 'intake', name: '需求评估', outputs: ['intake-review.md'] },
      { id: 'estimate', name: '任务工时评估', outputs: ['estimate.md'] },
    ],
    edges: [{ from: 'intake', to: 'estimate' }],
  }

  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <ReactFlowProvider>
            <FlowCanvas ref={canvasRef} initialSteps={proposal} onSave={() => {}} />
          </ReactFlowProvider>
        </I18nProvider>,
      )
    })
    assert.match(container.textContent || '', /需求评估/)
    assert.deepEqual(canvasRef.current?.getSteps().connections, [
      { from: 1, fromPort: 0, to: 2, toPort: 0, kind: 'solid' },
    ])
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
