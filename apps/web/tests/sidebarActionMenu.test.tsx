import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SidebarActionItem, SidebarActionMenu } from '../src/components/SidebarActionMenu'

test('sidebar menu actions share accessible compact styling and remain above the mobile drawer', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let selected = false
  try {
    await act(async () => root.render(
      <SidebarActionMenu x={20} y={30}>
        <SidebarActionItem icon="pencil" onClick={() => { selected = true }}>Rename</SidebarActionItem>
      </SidebarActionMenu>,
    ))
    const menu = container.querySelector<HTMLElement>('.sidebar-action-menu')
    const item = container.querySelector<HTMLButtonElement>('button.sidebar-action-item')
    assert.ok(menu)
    assert.ok(item)
    assert.equal(menu.style.left, '20px')
    assert.equal(item.textContent, 'Rename')
    await act(async () => item.click())
    assert.equal(selected, true)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
