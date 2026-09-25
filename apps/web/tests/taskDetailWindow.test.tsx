import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import TaskDetailWindow from '../src/components/TaskDetailWindow'

test('task window moves, resizes from its edges, and persists bounded geometry', async () => {
  const { window } = installDomEnvironment()
  window.innerWidth = 1200
  window.innerHeight = 800
  window.sessionStorage.setItem('workstep:task-detail-bounds', JSON.stringify({
    x: 100, y: 80, width: 800, height: 600,
  }))
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><TaskDetailWindow title="Build" onClose={() => {}}>
      {({ onHeaderPointerDown, onHeaderKeyDown, onHeaderDoubleClick }) =>
        <div className="test-task-header" tabIndex={0}
          onPointerDown={onHeaderPointerDown} onKeyDown={onHeaderKeyDown}
          onDoubleClick={onHeaderDoubleClick}>
          <span className="task-detail-title">Build</span>
        </div>}
    </TaskDetailWindow></I18nProvider>))
    const dialog = container.querySelector<HTMLElement>('.task-detail-window')!
    assert.equal(dialog.style.left, '100px')
    assert.equal(dialog.querySelectorAll('[role="separator"]').length, 8)
    const east = dialog.querySelector<HTMLElement>('.task-detail-resize-e')!
    await act(async () => east.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'ArrowRight', bubbles: true,
    })))
    assert.equal(dialog.style.width, '812px')
    const header = dialog.querySelector<HTMLElement>('.test-task-header')!
    await act(async () => {
      header.dispatchEvent(new window.PointerEvent('pointerdown', {
        bubbles: true, clientX: 200, clientY: 100,
      }))
      window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 240, clientY: 120 }))
      window.dispatchEvent(new window.PointerEvent('pointerup'))
    })
    assert.equal(dialog.style.left, '140px')
    assert.equal(dialog.style.top, '100px')
    assert.deepEqual(JSON.parse(window.sessionStorage.getItem('workstep:task-detail-bounds')!), {
      x: 140, y: 100, width: 812, height: 600,
    })
    await act(async () => {
      header.querySelector<HTMLElement>('.task-detail-title')!.dispatchEvent(new window.PointerEvent('pointerdown', {
        bubbles: true, clientX: 200, clientY: 100,
      }))
      window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 300, clientY: 300 }))
      window.dispatchEvent(new window.PointerEvent('pointerup'))
    })
    assert.equal(dialog.style.left, '140px')
    await act(async () => header.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })))
    assert.equal(dialog.style.left, '180px')
    assert.equal(dialog.style.top, '0px')
    assert.equal(dialog.style.width, '1020px')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('compact task window hides resize handles and header drag actions', async () => {
  const { window } = installDomEnvironment()
  window.innerWidth = 390
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let hasHeaderDrag = true
  try {
    await act(async () => root.render(<I18nProvider><TaskDetailWindow title="Build" onClose={() => {}}>
      {({ onHeaderPointerDown }) => {
        hasHeaderDrag = Boolean(onHeaderPointerDown)
        return <div>Build</div>
      }}
    </TaskDetailWindow></I18nProvider>))
    assert.equal(hasHeaderDrag, false)
    assert.equal(container.querySelectorAll('.task-detail-resize-handle').length, 0)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
