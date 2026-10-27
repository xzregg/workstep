import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useChatPaneResize } from '../src/hooks/useChatPaneResize'

test('pane separators resize adjacent panes on both axes, clamp sizes and release drag listeners', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  function Harness({ layout = 'horizontal', compact = false, ids = ['a', 'b', 'c'] }: {
    layout?: 'horizontal' | 'vertical'; compact?: boolean; ids?: string[]
  }) {
    const resize = useChatPaneResize(ids, layout, compact)
    return <div ref={resize.ref} style={resize.style} data-grid>
      {ids.map((id, index) => <div key={id} className="chat-workspace-pane" data-pane={id}>
        {index < ids.length - 1 && !compact && <div role="separator" tabIndex={0}
          onPointerDown={event => resize.startResize(event, index)} onKeyDown={event => resize.resizeWithKeys(event, index)} />}
      </div>)}
    </div>
  }
  const pointer = async (target: Element | Window, type: string, x: number, y: number) => {
    await act(async () => {
      const event = new window.Event(type, { bubbles: true, cancelable: true })
      Object.assign(event, { button: 0, pointerId: 1, clientX: x, clientY: y })
      target.dispatchEvent(event)
    })
  }
  const grid = () => document.querySelector<HTMLElement>('[data-grid]')!
  const setupRects = () => {
    for (const pane of document.querySelectorAll<HTMLElement>('[data-pane]')) {
      pane.getBoundingClientRect = () => ({ width: 500, height: 400 }) as DOMRect
    }
  }
  const separator = () => document.querySelector<HTMLElement>('[role=separator]')!
  try {
    await act(async () => root.render(<Harness />))
    setupRects()
    await pointer(separator(), 'pointerdown', 500, 0)
    await pointer(window as unknown as Window, 'pointermove', 600, 0)
    assert.match(grid().style.gridTemplateColumns, /600fr.*400fr.*500fr/)
    await pointer(window as unknown as Window, 'pointermove', 2000, 0)
    assert.match(grid().style.gridTemplateColumns, /640fr.*360fr.*500fr/)
    await pointer(window as unknown as Window, 'pointerup', 2000, 0)
    const resized = grid().style.gridTemplateColumns
    await pointer(window as unknown as Window, 'pointermove', 300, 0)
    assert.equal(grid().style.gridTemplateColumns, resized)
    assert.equal(document.body.classList.contains('chat-panes-resizing-horizontal'), false)
    await act(async () => root.render(<Harness layout="vertical" />))
    setupRects()
    await pointer(separator(), 'pointerdown', 0, 400)
    await pointer(window as unknown as Window, 'pointermove', 0, 450)
    assert.match(grid().style.gridTemplateRows, /450fr.*350fr.*400fr/)
    await pointer(window as unknown as Window, 'pointercancel', 0, 450)
    assert.equal(document.body.classList.contains('chat-panes-resizing-vertical'), false)
    await act(async () => separator().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })))
    assert.match(grid().style.gridTemplateRows, /376fr.*424fr.*400fr/)
    await act(async () => root.render(<Harness />))
    assert.equal(grid().style.gridTemplateColumns, resized, 'orientation changes retain the corresponding sizes')
    await pointer(separator(), 'pointerdown', 500, 0)
    await act(async () => root.render(<Harness compact />))
    assert.equal(document.querySelector('[role=separator]'), null)
    assert.equal(document.body.classList.contains('chat-panes-resizing-horizontal'), false)
    await act(async () => root.render(<Harness ids={['a', 'b']} />))
    assert.doesNotMatch(grid().style.gridTemplateColumns, /640fr/)
    setupRects()
    await pointer(separator(), 'pointerdown', 500, 0)
  } finally {
    await act(async () => root.unmount())
    assert.equal(document.body.classList.contains('chat-panes-resizing-horizontal'), false)
    await window.happyDOM.close()
  }
})
