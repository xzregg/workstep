import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import FlowCanvas, { type FlowCanvasHandle } from '../src/components/FlowCanvas'
import { I18nProvider, useLocaleStore } from '../src/i18n'

function setNativeValue(
  window: Window,
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype = element instanceof window.HTMLInputElement
    ? window.HTMLInputElement.prototype
    : window.HTMLTextAreaElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
}

function installDom() {
  useLocaleStore.getState().setLocale('zh-CN')
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


test('keyboard deletion removes connections attached to the deleted stage', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const canvasRef = createRef<FlowCanvasHandle>()
  try {
    await act(async () => root.render(
      <I18nProvider><ReactFlowProvider>
        <FlowCanvas
          ref={canvasRef}
          initialSteps={{
            nodes: [
              { id: 1, type: 'draft', title: '起草' },
              { id: 2, type: 'review', title: '审核' },
            ],
            connections: [{ from: 1, to: 2 }],
          }}
          onSave={() => {}}
        />
      </ReactFlowProvider></I18nProvider>,
    ))

    const stageNodes = container.querySelectorAll<HTMLElement>('.react-flow__node')
    assert.equal(stageNodes.length, 2)
    await act(async () => stageNodes[0].click())
    assert.match(stageNodes[0].className, /selected/)
    await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Delete' })))

    assert.deepEqual(canvasRef.current?.getSteps().nodes.map((node: { id: number }) => node.id), [2])
    assert.deepEqual(canvasRef.current?.getSteps().connections, [])
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('bookmarks round-trip separately from executable stages and can be added from the stage menu', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const canvasRef = createRef<FlowCanvasHandle>()
  const bookmark = { id: 'note-1', title: '发布检查', text: '发布前检查', position: { x: 40, y: 80 }, width: 420, height: 280 }
  try {
    await act(async () => root.render(
      <I18nProvider><ReactFlowProvider>
        <FlowCanvas ref={canvasRef} initialSteps={{ nodes: [], connections: [], bookmarks: [bookmark] }} onSave={() => {}} />
      </ReactFlowProvider></I18nProvider>,
    ))
    assert.deepEqual(canvasRef.current?.getSteps().bookmarks, [bookmark])
    assert.deepEqual(canvasRef.current?.getSteps().nodes, [])
    assert.equal(canvasRef.current?.validate(), null)
    const titleInput = container.querySelector('.flow-bookmark-header input[aria-label="书签标题"]')!
    const textarea = container.querySelector('textarea')!
    assert.equal(titleInput.value, '发布检查')
    assert.equal(textarea.value, '发布前检查')
    assert.equal(
      textarea.classList.contains('nowheel'),
      false,
      'bookmark notes must not block canvas zoom',
    )
    await act(async () => {
      setNativeValue(window, titleInput, '上线前')
      titleInput.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(canvasRef.current?.getSteps().bookmarks[0].title, '上线前')
    await act(async () => {
      setNativeValue(window, textarea, '检查完成\n可以发布')
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(canvasRef.current?.getSteps().bookmarks[0].text, '检查完成\n可以发布')
    const menu = [...container.querySelectorAll('button')].find(button => /阶段.*▾/.test(button.textContent || ''))!
    await act(async () => menu.click())
    const addBookmark = [...document.querySelectorAll('button')].find(button => button.textContent === '书签')
    assert.ok(addBookmark)
    await act(async () => addBookmark.click())
    assert.equal(canvasRef.current?.getSteps().bookmarks.length, 2)
    assert.deepEqual(canvasRef.current?.getSteps().nodes, [])
    const saved = canvasRef.current?.getSteps()
    await act(async () => canvasRef.current?.loadSteps(saved))
    assert.deepEqual(canvasRef.current?.getSteps(), saved)
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="删除书签"]')!
    await act(async () => remove.click())
    assert.equal(canvasRef.current?.getSteps().bookmarks.length, 2)
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === '确认') as HTMLButtonElement
    await act(async () => confirm.click())
    assert.equal(canvasRef.current?.getSteps().bookmarks.length, 1)
    await act(async () => root.render(
      <I18nProvider><ReactFlowProvider>
        <FlowCanvas ref={canvasRef} readOnly initialSteps={saved} onSave={() => {}} />
      </ReactFlowProvider></I18nProvider>,
    ))
    assert.equal(container.querySelector<HTMLInputElement>('input[aria-label="书签标题"]')?.readOnly, true)
    assert.equal(container.querySelector('textarea')?.readOnly, true)
    assert.equal(container.querySelector('button[aria-label="删除书签"]'), null)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('bookmark title and note keep IME drafts until composition ends', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const canvasRef = createRef<FlowCanvasHandle>()
  const bookmark = { id: 'note-ime', title: '发布检查', text: '备注', position: { x: 40, y: 80 } }
  try {
    await act(async () => root.render(
      <I18nProvider><ReactFlowProvider>
        <FlowCanvas ref={canvasRef} initialSteps={{ nodes: [], connections: [], bookmarks: [bookmark] }} onSave={() => {}} />
      </ReactFlowProvider></I18nProvider>,
    ))
    const titleInput = container.querySelector<HTMLInputElement>('.flow-bookmark-header input[aria-label="书签标题"]')!
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!

    await act(async () => {
      titleInput.dispatchEvent(new window.Event('compositionstart', { bubbles: true }))
      setNativeValue(window, titleInput, 'fabu')
      titleInput.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(titleInput.value, 'fabu')
    assert.equal(canvasRef.current?.getSteps().bookmarks[0].title, '发布检查')
    await act(async () => {
      setNativeValue(window, titleInput, '发布')
      titleInput.dispatchEvent(new window.Event('compositionend', { bubbles: true }))
    })
    assert.equal(titleInput.value, '发布')
    assert.equal(canvasRef.current?.getSteps().bookmarks[0].title, '发布')

    await act(async () => {
      textarea.dispatchEvent(new window.Event('compositionstart', { bubbles: true }))
      setNativeValue(window, textarea, 'beizhu')
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(textarea.value, 'beizhu')
    assert.equal(canvasRef.current?.getSteps().bookmarks[0].text, '备注')
    await act(async () => {
      setNativeValue(window, textarea, '备注更新')
      textarea.dispatchEvent(new window.Event('compositionend', { bubbles: true }))
    })
    assert.equal(textarea.value, '备注更新')
    assert.equal(canvasRef.current?.getSteps().bookmarks[0].text, '备注更新')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('an executable stage with an empty engine follows the default and new stages start on it', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const canvasRef = createRef<FlowCanvasHandle>()
  try {
    await act(async () => root.render(
      <I18nProvider><ReactFlowProvider>
        <FlowCanvas
          ref={canvasRef}
          initialSteps={{ nodes: [{ id: 1, type: 'build', title: '构建', engine: '' }], connections: [] }}
          onSave={() => {}}
        />
      </ReactFlowProvider></I18nProvider>,
    ))
    assert.equal(canvasRef.current?.getSteps().nodes[0].engine, '')

    const menu = [...container.querySelectorAll('button')].find(button => /阶段.*▾/.test(button.textContent || ''))!
    await act(async () => menu.click())
    const addStage = [...document.querySelectorAll('button')].find(button => button.textContent === '+ 阶段')
    assert.ok(addStage)
    await act(async () => addStage.click())

    const added = canvasRef.current?.getSteps().nodes.at(-1)
    assert.equal(added.engine, '')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('stage return rounds default to three and remain editable independently of review retries', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const canvasRef = createRef<FlowCanvasHandle>()
  try {
    await act(async () => root.render(
      <I18nProvider><ReactFlowProvider>
        <FlowCanvas
          ref={canvasRef}
          initialSteps={{
            nodes: [{
              id: 1,
              type: 'test',
              title: '测试',
              maxReturnRounds: 5,
              review: { mode: 'auto', auto: true, maxRetries: 1 },
            }],
            connections: [],
          }}
          onSave={() => {}}
        />
      </ReactFlowProvider></I18nProvider>,
    ))
    assert.equal(canvasRef.current?.getSteps().nodes[0].maxReturnRounds, 5)
    assert.equal(canvasRef.current?.getSteps().nodes[0].review.maxRetries, 1)

    const stageNode = container.querySelector<HTMLElement>('.react-flow__node')!
    await act(async () => stageNode.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })))
    const input = container.querySelector<HTMLInputElement>('input[aria-label="最大返回次数"]')!
    assert.ok(input)
    assert.equal(input.value, '5')
    await act(async () => {
      setNativeValue(window, input, '4')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    const stash = [...container.querySelectorAll('button')].find(button => button.textContent === '暂存')!
    await act(async () => stash.click())
    assert.equal(canvasRef.current?.getSteps().nodes[0].maxReturnRounds, 4)
    assert.equal(canvasRef.current?.getSteps().nodes[0].review.maxRetries, 1)

    const menu = [...container.querySelectorAll('button')].find(button => /阶段.*▾/.test(button.textContent || ''))!
    await act(async () => menu.click())
    const addStage = [...document.querySelectorAll('button')].find(button => button.textContent === '+ 阶段')!
    await act(async () => addStage.click())
    assert.equal(canvasRef.current?.getSteps().nodes.at(-1).maxReturnRounds, 3)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
