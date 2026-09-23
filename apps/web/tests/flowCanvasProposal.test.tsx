import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act, createRef, useState } from 'react'
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

test('warns before saving when a verifier requires a feedback-only output', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const saved: unknown[] = []
  try {
    await act(async () => root.render(
      <I18nProvider><ReactFlowProvider>
        <FlowCanvas
          initialSteps={{
            nodes: [
              { id: 1, type: 'develop', title: '开发', inputs: [{ name: '需求', type: 'md', outputs: [{ name: '文档', type: 'md' }] }, { name: '修复', type: 'md', outputs: [{ name: '修复列表', type: 'md' }] }], outputs: [{ name: '文档', type: 'md' }, { name: '修复列表', type: 'md' }] },
              { id: 2, type: 'test', title: '测试', inputs: [{ name: '开发成果', type: 'md' }], outputs: [{ name: 'Bug 列表', type: 'md' }] },
            ],
            connections: [
              { from: 1, fromPort: 0, to: 2, toPort: 0, kind: 'solid' },
              { from: 1, fromPort: 1, to: 2, toPort: 0, kind: 'solid' },
              { from: 2, fromPort: 0, to: 1, toPort: 1, kind: 'dashed' },
            ],
          }}
          onSave={(steps) => { saved.push(steps) }}
        />
      </ReactFlowProvider></I18nProvider>,
    ))
    const save = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === '保存')
    assert.ok(save)
    await act(async () => save.click())
    assert.equal(saved.length, 0)
    assert.match(document.body.textContent || '', /“测试”可能无法执行/)
    assert.doesNotMatch(document.body.textContent || '', /“开发”→“测试”/)
    const confirm = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === '仍然保存')
    assert.ok(confirm)
    await act(async () => confirm.click())
    assert.equal(saved.length, 1)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

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


test('keyboard deletion removes connections attached to the deleted step', async () => {
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

    const stepNodes = container.querySelectorAll<HTMLElement>('.react-flow__node')
    assert.equal(stepNodes.length, 2)
    await act(async () => stepNodes[0].click())
    assert.match(stepNodes[0].className, /selected/)
    await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Delete' })))

    assert.deepEqual(canvasRef.current?.getSteps().nodes.map((node: { id: number }) => node.id), [2])
    assert.deepEqual(canvasRef.current?.getSteps().connections, [])
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('bookmarks round-trip separately from executable steps and can be added from the step menu', async () => {
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
    const menu = [...container.querySelectorAll('button')].find(button => /步骤.*▾/.test(button.textContent || ''))!
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


test('an executable step with an empty engine follows the default and new steps start on it', async () => {
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

    const menu = [...container.querySelectorAll('button')].find(button => /步骤.*▾/.test(button.textContent || ''))!
    await act(async () => menu.click())
    const addStep = [...document.querySelectorAll('button')].find(button => button.textContent === '+ 步骤')
    assert.ok(addStep)
    await act(async () => addStep.click())

    const added = canvasRef.current?.getSteps().nodes.at(-1)
    assert.equal(added.engine, '')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('step return rounds default to three and remain editable independently of review retries', async () => {
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

    const stepNode = container.querySelector<HTMLElement>('.react-flow__node')!
    await act(async () => stepNode.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })))
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

    const menu = [...container.querySelectorAll('button')].find(button => /步骤.*▾/.test(button.textContent || ''))!
    await act(async () => menu.click())
    const addStep = [...document.querySelectorAll('button')].find(button => button.textContent === '+ 步骤')!
    await act(async () => addStep.click())
    assert.equal(canvasRef.current?.getSteps().nodes.at(-1).maxReturnRounds, 3)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('saving the workflow also commits the active step draft without staging it first', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let savedSteps: any = null
  try {
    await act(async () => root.render(
      <I18nProvider><ReactFlowProvider>
        <FlowCanvas
          initialSteps={{
            nodes: [{ id: 1, type: 'test', title: '测试', maxReturnRounds: 3 }],
            connections: [],
          }}
          onSave={(steps) => { savedSteps = steps }}
        />
      </ReactFlowProvider></I18nProvider>,
    ))

    const stepNode = container.querySelector<HTMLElement>('.react-flow__node')!
    await act(async () => stepNode.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })))
    const input = container.querySelector<HTMLInputElement>('input[aria-label="最大返回次数"]')!
    await act(async () => {
      setNativeValue(window, input, '6')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })

    const save = [...container.querySelectorAll('button')].find(button => button.textContent === '保存')!
    await act(async () => save.click())

    assert.equal(savedSteps.nodes[0].maxReturnRounds, 6)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('staging then saving does not reload the canvas from its own saved steps', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const initialSteps = {
    nodes: [{ id: 1, type: 'test', title: '测试', maxReturnRounds: 3 }],
    connections: [],
  }
  function SavedCanvas() {
    const [steps, setSteps] = useState<any>(initialSteps)
    return <FlowCanvas initialSteps={steps} onSave={(nextSteps) => setSteps(nextSteps)} />
  }

  try {
    await act(async () => root.render(
      <I18nProvider><ReactFlowProvider><SavedCanvas /></ReactFlowProvider></I18nProvider>,
    ))
    const stepNode = container.querySelector<HTMLElement>('.react-flow__node')!
    await act(async () => stepNode.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })))
    const input = container.querySelector<HTMLInputElement>('input[aria-label="最大返回次数"]')!
    await act(async () => {
      setNativeValue(window, input, '4')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    const stash = [...container.querySelectorAll('button')].find(button => button.textContent === '暂存')!
    await act(async () => stash.click())
    const save = [...container.querySelectorAll('button')].find(button => button.textContent === '保存')!
    const originalSetTimeout = globalThis.setTimeout
    let fitViewSchedules = 0
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: any[]) => {
      if (delay === 100) fitViewSchedules++
      return originalSetTimeout(callback, delay, ...args)
    }) as typeof setTimeout
    try {
      await act(async () => save.click())
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }

    assert.equal(fitViewSchedules, 0, 'saving should not schedule fitView')
    assert.equal(container.querySelector<HTMLInputElement>('input[aria-label="最大返回次数"]')?.value, '4')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
