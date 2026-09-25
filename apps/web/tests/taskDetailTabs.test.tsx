import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import TaskDetailTabs from '../src/components/TaskDetailTabs'

test('shared tabs select by click and arrow key with one tab in the keyboard order', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let selected = 'detail'
  const render = () => <TaskDetailTabs className="task-detail-primary-tabs" selected={selected}
    onSelect={(tab) => { selected = tab; root.render(render()) }}
    tabs={[{ id: 'detail', label: '详情' }, { id: 'artifacts', label: '产物' }]} />
  try {
    await act(async () => root.render(render()))
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true')
    assert.equal(tabs[1].tabIndex, -1)
    await act(async () => tabs[1].click())
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true')
    assert.equal(tabs[0].tabIndex, -1)
    await act(async () => tabs[1].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
