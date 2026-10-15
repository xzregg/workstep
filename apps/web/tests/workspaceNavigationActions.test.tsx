import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import WorkspaceNavigationActions from '../src/components/WorkspaceNavigationActions'

test('desktop rail opens existing appearance and role settings, and keeps one schedule entry', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const opened: string[] = []
  function Surface() { const location = useLocation(); return <><WorkspaceNavigationActions onOpenSettings={section => opened.push(section)} activeSettingsSection="roles" /><output>{location.pathname}</output></> }
  try {
    await act(async () => root.render(<I18nProvider><MemoryRouter><Surface /></MemoryRouter></I18nProvider>))
    const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
    assert.ok(button('设置'), container.innerHTML)
    assert.ok(button('数据统计'), container.innerHTML)
    assert.ok(button('外观'))
    assert.ok(button('角色中心'))
    assert.deepEqual([...container.querySelectorAll('nav > button')].slice(0, 3).map(button => button.getAttribute('aria-label')), ['数据统计', '定时任务', '角色中心'])
    assert.ok(button('角色中心').querySelector('svg.lucide-drama'))
    assert.equal(container.querySelector('button[aria-label="工作台"]'), null)
    assert.equal(container.querySelector('button[aria-label="项目与会话"]'), null)
    await act(async () => button('外观').click())
    await act(async () => button('角色中心').click())
    await act(async () => button('设置').click())
    assert.deepEqual(opened, ['appearance', 'roles', 'providers'])
    assert.equal(button('角色中心').getAttribute('aria-current'), 'page')
    assert.equal(container.querySelectorAll('button[aria-haspopup="dialog"]').length, 1)
    await act(async () => button('数据统计').click())
    assert.equal(container.querySelector('output')!.textContent, '/statistics')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('project gateway keeps personal appearance and hides host role/settings entries', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('https://d-demo.gateway.example/')
  useLocaleStore.setState({ locale: 'zh-CN' })
  const opened: string[] = []
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  function Surface() { const location = useLocation(); return <><WorkspaceNavigationActions onOpenSettings={section => opened.push(section)} /><output>{location.pathname}</output></> }
  try {
    await act(async () => root.render(<I18nProvider><MemoryRouter><Surface /></MemoryRouter></I18nProvider>))
    assert.equal(container.querySelector('[aria-label="角色中心"]'), null)
    assert.equal(container.querySelector('[aria-label="设置"]'), null)
    assert.equal(container.querySelector('[aria-label="数据统计"]'), null)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="外观"]')!.click())
    assert.deepEqual(opened, [])
    assert.equal(container.querySelector('output')!.textContent, '/appearance')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('rail stays outside the lists on PC and mobile keeps its compact three-button footer', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width: 1280, height: 900 })
  useLocaleStore.setState({ locale: 'zh-CN' })
  const style = document.createElement('style')
  style.textContent = await readFile(new URL('../src/components/Layout.css', import.meta.url), 'utf8')
  document.head.appendChild(style)
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><MemoryRouter><WorkspaceNavigationActions onOpenSettings={() => {}} /></MemoryRouter></I18nProvider>))
    const appearance = container.querySelector<HTMLElement>('[aria-label="外观"]')!
    assert.equal(getComputedStyle(appearance).display, 'flex')
    assert.equal(getComputedStyle(appearance).marginTop, 'auto', 'personal tools belong at the bottom of the desktop rail')
    const body = document.body.appendChild(document.createElement('div'))
    body.className = 'layout-sidebar-body'
    const panel = body.appendChild(document.createElement('section'))
    panel.className = 'layout-sidebar-project-panel'
    assert.equal(getComputedStyle(panel).minWidth, '0', 'long project/session titles must not widen the grid item and clip right-side status/actions')
    assert.equal(getComputedStyle(body).gridTemplateColumns, 'minmax(0, 1fr)')
    await act(async () => window.happyDOM.setWindowSize({ width: 390, height: 844 }))
    // Invalidate happy-dom's computed-style cache after changing the viewport.
    style.textContent += '\n'
    const visible = [...container.querySelectorAll<HTMLElement>('button')].filter(button => getComputedStyle(button).display !== 'none')
    assert.deepEqual(visible.map(button => button.getAttribute('aria-label')), ['数据统计', '定时任务', '设置'])
    assert.equal(getComputedStyle(container.querySelector('nav')!).display, 'flex')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
