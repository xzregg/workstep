import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import WorkspaceSidebarSections from '../src/components/WorkspaceSidebarSections'

for (const compact of [false, true]) test(`${compact ? 'mobile' : 'desktop'} sidebar sections preserve their own content while collapsing/reordering`, async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width: compact ? 390 : 1280, height: 900 })
  useLocaleStore.setState({ locale: 'zh-CN' })
  const host = document.body.appendChild(document.createElement('div'))
  let root = createRoot(host)
  const render = () => act(async () => root.render(<I18nProvider><MemoryRouter><WorkspaceSidebarSections
    projectActions={<button>搜索项目</button>} projects={<input aria-label="原项目内容" defaultValue="原有展开状态" />}
  /></MemoryRouter></I18nProvider>))
  const order = () => [...host.querySelectorAll('.layout-sidebar-body > section')].map(el => el.getAttribute('aria-label'))
  try {
    await render()
    assert.deepEqual(order(), ['项目', '最近聊天'])
    const projectInput = host.querySelector<HTMLInputElement>('input')!
    projectInput.value = '保持输入和原项目树状态'
    const title = host.querySelector<HTMLButtonElement>('button[aria-controls="workspace-projects-content"]')
    if (compact) {
      assert.equal(title, null)
      assert.equal(host.querySelector('[data-reorderable="true"]'), null)
      assert.equal(host.querySelector('[role="separator"]'), null)
      return
    }
    assert.ok(title)
    await act(async () => title.click())
    assert.equal(title.getAttribute('aria-expanded'), 'false')
    assert.equal(host.querySelector<HTMLElement>('#workspace-projects-content')?.hidden, true)
    assert.equal(host.querySelector('[role="separator"]'), null)
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-controls="workspace-recent-content"]')!.click())
    assert.equal(host.querySelector<HTMLElement>('#workspace-recent-content')?.hidden, true)
    await act(async () => title.click())
    assert.equal(projectInput.value, '保持输入和原项目树状态')
    const headings = host.querySelectorAll<HTMLElement>('[data-sidebar-section-heading]')
    const pointer = (name: string, y: number) => new window.PointerEvent(name, { bubbles: true, cancelable: true, button: 0, clientX: 80, clientY: y })
    await act(async () => headings[1].dispatchEvent(pointer('pointerdown', 400)))
    await act(async () => headings[0].dispatchEvent(pointer('pointermove', 70)))
    assert.equal(document.querySelector('.layout-sidebar-drag-preview')?.textContent, '最近聊天')
    assert.equal(headings[0].getAttribute('data-drop-position'), 'before')
    await act(async () => headings[0].dispatchEvent(pointer('pointerup', 70)))
    assert.equal(document.querySelector('.layout-sidebar-drag-preview'), null)
    assert.equal(host.querySelector('[data-drop-position]'), null)
    assert.deepEqual(order(), ['最近聊天', '项目'])
    assert.equal(host.querySelector('input'), projectInput, 'reordering must keep original project tree mounted')
    await act(async () => headings[0].dispatchEvent(pointer('pointerdown', 70)))
    await act(async () => headings[1].dispatchEvent(pointer('pointermove', 400)))
    assert.ok(document.querySelector('.layout-sidebar-drag-preview'))
    await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(document.querySelector('.layout-sidebar-drag-preview'), null)
    await act(async () => headings[1].dispatchEvent(pointer('pointerup', 400)))
    assert.deepEqual(order(), ['最近聊天', '项目'], 'Escape cancels the move')
    await act(async () => root.unmount())
    root = createRoot(host)
    await render()
    assert.deepEqual(order(), ['最近聊天', '项目'])
    assert.equal(host.querySelector('button[aria-controls="workspace-recent-content"]')?.getAttribute('aria-expanded'), 'false')
    await act(async () => window.happyDOM.setWindowSize({ width: 390, height: 844 }))
    assert.deepEqual(order(), ['项目', '最近聊天'], 'desktop preferences must not reorder the mobile drawer')
    assert.equal(host.querySelector<HTMLElement>('#workspace-recent-content')?.hidden, false)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('desktop split height follows dragging, persists, and respects reversed section order', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width: 1280, height: 900 })
  const host = document.body.appendChild(document.createElement('div'))
  let root = createRoot(host)
  const render = () => act(async () => root.render(<I18nProvider><MemoryRouter><WorkspaceSidebarSections projectActions={null} projects={<div>项目树</div>} /></MemoryRouter></I18nProvider>))
  const pointer = (name: string, y: number) => new window.PointerEvent(name, { bubbles: true, button: 0, clientY: y })
  const handle = () => host.querySelector<HTMLElement>('[role="separator"]')!
  const drag = async (dy: number) => {
    const body = host.querySelector<HTMLElement>('.layout-sidebar-body')!
    body.getBoundingClientRect = () => ({ height: 600, top: 0 } as DOMRect)
    await act(async () => handle().dispatchEvent(pointer('pointerdown', 300)))
    await act(async () => document.dispatchEvent(pointer('pointermove', 300 + dy)))
    await act(async () => document.dispatchEvent(pointer('pointerup', 300 + dy)))
  }
  try {
    await render()
    assert.ok(handle())
    const original = Number(handle().getAttribute('aria-valuenow'))
    await drag(-100)
    const taller = Number(handle().getAttribute('aria-valuenow'))
    assert.ok(taller > original, 'moving the divider up enlarges recent chats below')
    await act(async () => root.unmount())
    root = createRoot(host)
    await render()
    assert.equal(Number(handle().getAttribute('aria-valuenow')), taller)
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-controls="workspace-recent-content"]')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true })))
    await drag(100)
    assert.ok(Number(handle().getAttribute('aria-valuenow')) > taller, 'after swapping, dragging down enlarges recent chats above')
    await drag(10000)
    assert.equal(handle().getAttribute('aria-valuenow'), '85')
    await act(async () => handle().dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })))
    assert.equal(handle().getAttribute('aria-valuenow'), '33')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
