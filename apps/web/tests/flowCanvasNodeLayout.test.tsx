import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import FlowCanvas, { type FlowCanvasHandle } from '../src/components/FlowCanvas'
import WorkflowDebugControls, { type WorkflowDebugHandle } from '../src/components/WorkflowDebugControls'
import { loadCanvasData } from '../src/components/flowCanvasData'
import { I18nProvider, useLocaleStore } from '../src/i18n'

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

test('standalone appended outputs keep their handles and connections', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const workflow = { nodes: [
    { id: 'a', type: 'a', inputs: [], outputs: [{ name: 'a1', type: 'md' }, { name: 'a2', type: 'md' }] },
    { id: 'b', type: 'b', inputs: [{ name: 'a2', type: 'md' }] },
  ], connections: [{ from: 'a', fromPort: 1, to: 'b', toPort: 0 }] }
  try {
    assert.equal(loadCanvasData(workflow).connections.length, 1)
    await act(async () => root.render(<I18nProvider><FlowCanvas initialSteps={workflow} onSave={() => {}} /></I18nProvider>))
    const source = container.querySelector('.react-flow__node')!
    assert.equal(source.querySelectorAll('.source').length, 2)
    assert.match(source.textContent || '', /a1/)
    assert.match(source.textContent || '', /a2/)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

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


test('right-click debugging opens the chosen step with its upstream sample fields', async () => {
  const window = installDom()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const canvas = createRef<FlowCanvasHandle>()
  const debug = createRef<WorkflowDebugHandle>()
  const project = { id: 'project', path: '/project', name: 'Project', workflows: [] }
  const workflow = { nodes: [
    { id: 1, type: 'a', title: 'A', outputs: [{ name: 'plan', type: 'Markdown' }] },
    { id: 2, type: 'b', title: 'B', inputs: [{ name: 'plan', type: 'Markdown' }] },
  ], connections: [{ from: 1, fromPort: 0, to: 2, toPort: 0 }] }
  try {
    const render = (enabled: boolean) => act(async () => root.render(
      <I18nProvider><FlowCanvas initialSteps={workflow} onSave={() => assert.fail('Unexpected save')}
        ref={canvas} onDebugStep={enabled ? id => debug.current?.open(id) : undefined}
        toolbarRight={<WorkflowDebugControls ref={debug} project={project} sourceId="source"
          readDraft={() => canvas.current?.getDraft()} />} /></I18nProvider>,
    ))
    const rightClick = () => act(async () => {
      container.querySelector('[data-id="2"]')!.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }))
    })
    await render(false)
    await rightClick()
    const menuButton = () => [...container.querySelectorAll('button')].find(button => button.textContent === '从此步骤调试')
    assert.ok(menuButton() === undefined)
    await render(true)
    await rightClick()
    assert.ok(menuButton())
    await act(async () => menuButton()!.click())
    assert.equal(container.querySelector<HTMLInputElement>('.radio-card-group input:checked')?.value, 'b')
    assert.ok(container.querySelector('[id="debug-sample-a:0"]'))
    assert.ok(menuButton() === undefined)
    const cancel = [...container.querySelectorAll<HTMLButtonElement>('[role=dialog] button')]
      .find(button => button.textContent === '取消')!
    await act(async () => cancel.click())
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '调试')!.click())
    assert.equal(container.querySelector<HTMLInputElement>('.radio-card-group input:checked')?.value, 'a')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
