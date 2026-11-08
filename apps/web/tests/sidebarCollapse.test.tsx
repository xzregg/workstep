import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { useSkinSidebar } from '../src/hooks/useSkinSidebar'
import WorkspaceNavigationActions from '../src/components/WorkspaceNavigationActions'
import Layout from '../src/components/Layout'
import { useProjectStore } from '../src/stores/projectStore'

test('desktop collapse retains rail, list state and width; restores after remount and never collapses mobile', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width: 1280, height: 900 })
  useLocaleStore.setState({ locale: 'zh-CN' })
  const style = document.head.appendChild(document.createElement('style'))
  style.textContent = await readFile(new URL('../src/components/Layout.css', import.meta.url), 'utf8')
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  function Surface() {
    const sidebar = useSkinSidebar()
    return <aside className={`layout-sidebar${sidebar.collapsed ? ' layout-sidebar--collapsed' : ''}`}>
      <div className="layout-sidebar-header">WorkStep</div>
      <div className="layout-sidebar-body"><input defaultValue="保留的搜索" /></div>
      <WorkspaceNavigationActions onOpenSettings={() => {}} sidebarCollapsed={sidebar.collapsed} onToggleSidebar={sidebar.toggleCollapsed} />
      <output>{sidebar.width}</output>
      <button onClick={() => sidebar.nudge(16)}>resize</button>
    </aside>
  }
  const render = () => root.render(<I18nProvider><MemoryRouter><Surface /></MemoryRouter></I18nProvider>)
  const toggle = () => container.querySelector<HTMLButtonElement>('.layout-sidebar-toggle')!
  const body = () => container.querySelector<HTMLElement>('.layout-sidebar-body')!
  try {
    await act(async () => render())
    assert.equal(toggle().getAttribute('aria-label'), '收起对话列表')
    assert.equal(container.querySelector('nav > button'), toggle())
    assert.ok(toggle().querySelector('.lucide-panel-left-close'))
    await act(async () => container.querySelector<HTMLButtonElement>('aside > button')!.click())
    const width = container.querySelector('output')!.textContent
    const input = container.querySelector('input')!
    input.value = '输入未丢失'
    await act(async () => toggle().click())
    assert.equal(toggle().getAttribute('aria-expanded'), 'false')
    assert.equal(toggle().getAttribute('aria-label'), '展开对话列表')
    assert.ok(toggle().querySelector('.lucide-panel-left-open'))
    assert.equal(getComputedStyle(body()).display, 'none')
    assert.equal(getComputedStyle(container.querySelector('aside')!).minWidth, '48px')
    assert.equal(getComputedStyle(toggle()).display, 'flex')
    await act(async () => toggle().click())
    assert.equal(container.querySelector('input'), input)
    assert.equal(input.value, '输入未丢失')
    assert.equal(container.querySelector('output')!.textContent, width)
    await act(async () => toggle().click())
    await act(async () => root.render(null))
    await act(async () => render())
    assert.equal(toggle().getAttribute('aria-expanded'), 'false')
    document.documentElement.dataset.skinSidebar = 'right'
    style.textContent += '\n'
    assert.equal(getComputedStyle(container.querySelector('aside')!).gridTemplateColumns, '48px')
    assert.equal(getComputedStyle(container.querySelector('nav')!).gridColumn, '1')
    await act(async () => window.happyDOM.setWindowSize({ width: 390, height: 844 }))
    style.textContent += '\n'
    assert.equal(toggle().getAttribute('aria-expanded'), 'true')
    assert.equal(getComputedStyle(toggle()).display, 'none')
    assert.notEqual(getComputedStyle(body()).display, 'none')
    await act(async () => window.happyDOM.setWindowSize({ width: 1280, height: 900 }))
    assert.equal(toggle().getAttribute('aria-expanded'), 'false')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('Layout expands the workspace and removes only the sidebar resize handle', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width: 1280, height: 900 })
  const oldFetch = globalThis.fetch, oldSocket = globalThis.WebSocket
  const projectState = useProjectStore.getState()
  class Socket {
    static OPEN = 1
    static CONNECTING = 0
    readyState = 1
    send() {}
    close() { this.readyState = 3 }
  }
  Object.assign(globalThis, { WebSocket: Socket, ResizeObserver: window.ResizeObserver })
  globalThis.fetch = async () => Response.json({ projects: [], sessions: [], engines: [], providers: [], buttons: [] })
  useProjectStore.setState({ projects: [], activeProject: null })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><MemoryRouter><Layout onSelectProject={() => {}}><input data-test="conversation" defaultValue="未发送草稿" /></Layout></MemoryRouter></I18nProvider>))
    const sidebar = container.querySelector<HTMLElement>('.layout-sidebar')!
    const originalWidth = sidebar.style.width
    const list = sidebar.querySelector('.layout-sidebar-body')
    const conversation = container.querySelector('[data-test="conversation"]')
    const toggle = container.querySelector<HTMLButtonElement>('.layout-sidebar-toggle')!
    assert.ok(container.querySelector('.app-shell > .task-detail-split-handle'))
    await act(async () => toggle.click())
    assert.equal(sidebar.style.width, '48px')
    assert.ok(sidebar.classList.contains('layout-sidebar--collapsed'))
    assert.equal(container.querySelector('.app-shell > .task-detail-split-handle'), null)
    assert.equal(sidebar.querySelector('.layout-sidebar-body'), list)
    assert.equal(container.querySelector('[data-test="conversation"]'), conversation)
    await act(async () => toggle.click())
    assert.equal(sidebar.style.width, originalWidth)
    assert.ok(container.querySelector('.app-shell > .task-detail-split-handle'))
  } finally {
    await act(async () => root.unmount())
    useProjectStore.setState(projectState, true)
    globalThis.fetch = oldFetch
    globalThis.WebSocket = oldSocket
    await window.happyDOM.close()
  }
})
