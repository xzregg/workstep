import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import SidebarStatusIndicator from '../src/components/SidebarStatusIndicator.tsx'

test('sidebar status indicator prioritizes running, then failure, then completion', async () => {
  const window = new Window()
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(<SidebarStatusIndicator running failed completed runningTitle="运行中" failedTitle="失败" completedTitle="完成" />)
    })
    assert.ok(container.querySelector('.task-status-spinner'))

    await act(async () => {
      root.render(<SidebarStatusIndicator failed completed runningTitle="运行中" failedTitle="失败" completedTitle="完成" />)
    })
    assert.equal(container.querySelector('.sidebar-failure-dot')?.getAttribute('aria-label'), '失败')

    await act(async () => {
      root.render(<SidebarStatusIndicator completed runningTitle="运行中" failedTitle="失败" completedTitle="完成" />)
    })
    assert.equal(container.querySelector('.sidebar-completion-dot')?.getAttribute('aria-label'), '完成')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
