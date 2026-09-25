import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import TaskDetailSplitLayout from '../src/components/TaskDetailSplitLayout'

test('task detail divider restores its ratio, clamps drag, and cleans up listeners', async () => {
  const { window } = installDomEnvironment()
  window.sessionStorage.setItem('workstep:task-detail-split-ratio', '0.4')
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<TaskDetailSplitLayout mobileTab="steps"
      left={<span>Steps</span>} right={<span>Conversation</span>} />))
    const layout = container.querySelector<HTMLElement>('.task-detail-content')!
    assert.equal(layout.dataset.mobileTab, 'steps')
    assert.match(layout.style.gridTemplateColumns, /^0\.4fr 8px 0\.6fr$/)
    assert.equal(layout.textContent?.includes('Steps'), true)
    assert.equal(layout.textContent?.includes('Conversation'), true)
    layout.getBoundingClientRect = () => ({ left: 0, width: 1000 } as DOMRect)
    const divider = container.querySelector<HTMLElement>('.task-detail-split-handle')!
    await act(async () => {
      divider.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }))
      window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 990 }))
    })
    assert.equal(window.sessionStorage.getItem('workstep:task-detail-split-ratio'), '0.85')
    assert.match(layout.style.gridTemplateColumns, /^0\.85fr 8px 0\.15000000000000002fr$/)
    await act(async () => window.dispatchEvent(new window.PointerEvent('pointerup')))
    await act(async () => root.unmount())
    assert.equal(document.body.style.cursor, '')
  } finally {
    container.remove()
    await window.happyDOM.close()
  }
})
