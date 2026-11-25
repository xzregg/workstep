import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import WorkspaceNavigationActions from '../src/components/WorkspaceNavigationActions'
import { useProjectStore } from '../src/stores/projectStore'
import { digitalPersonApi } from '../src/api/digitalPerson'

test('desktop companion action sits directly below collapse and opens its default workspace', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width: 1440, height: 900 })
  useLocaleStore.setState({ locale: 'zh-CN' })
  const previous = useProjectStore.getState(), getProfile = digitalPersonApi.get
  const workspace = { id: 'home', name: '默认工作区', is_default_workspace: true } as any
  const originalProject = { id: 'project', name: '研发项目' } as any
  const originalChat = '/chat?project=%E7%A0%94%E5%8F%91%E9%A1%B9%E7%9B%AE&session=previous#message'
  useProjectStore.setState({ projects: [workspace, originalProject], activeProject: originalProject })
  digitalPersonApi.get = async () => ({ name: '小研', enabled: true } as any)
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  function Surface() {
    const location = useLocation()
    return <><WorkspaceNavigationActions onOpenSettings={() => {}} onToggleSidebar={() => {}} /><output>{location.pathname + location.search + location.hash}</output></>
  }
  try {
    await act(async () => root.render(<I18nProvider><MemoryRouter initialEntries={[originalChat]}><Surface /></MemoryRouter></I18nProvider>))
    const toggle = container.querySelector('.layout-sidebar-toggle')!
    const chat = container.querySelector<HTMLButtonElement>('[aria-label="与小研对话"]')!
    assert.ok(chat)
    assert.ok(toggle.nextElementSibling === chat)
    assert.ok(chat.querySelector('.lucide-bot'))
    const configIcon = container.querySelector('.layout-sidebar-digital-person svg')!
    assert.equal(configIcon.getAttribute('data-icon'), 'bot-settings')
    await act(async () => chat.click())
    assert.equal(container.querySelector('output')!.textContent, '/companion')
    assert.equal(useProjectStore.getState().activeProject?.id, workspace.id)
    assert.equal(chat.getAttribute('aria-current'), 'page')
    await act(async () => chat.click())
    assert.equal(container.querySelector('output')!.textContent, originalChat)
    assert.equal(useProjectStore.getState().activeProject?.id, originalProject.id)
    assert.equal(chat.getAttribute('aria-current'), null)
    await act(async () => chat.click())
    assert.equal(container.querySelector('output')!.textContent, '/companion')
    await act(async () => chat.click())
    assert.equal(container.querySelector('output')!.textContent, originalChat)
    await act(async () => root.render(<I18nProvider><MemoryRouter key="direct" initialEntries={['/companion']}><Surface /></MemoryRouter></I18nProvider>))
    await act(async () => container.querySelector<HTMLButtonElement>('.layout-sidebar-nav-button[aria-current="page"]')!.click())
    assert.equal(container.querySelector('output')!.textContent, `/chat?project=${encodeURIComponent(workspace.name)}`)
    assert.equal(useProjectStore.getState().activeProject?.id, workspace.id)
    await act(async () => window.happyDOM.setWindowSize({ width: 390, height: 844 }))
    assert.ok(container.querySelector('[aria-label="与小研对话"]') === null)
  } finally {
    await act(async () => root.unmount())
    useProjectStore.setState(previous, true)
    digitalPersonApi.get = getProfile
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
    assert.ok(container.querySelector('[aria-label="角色中心"]') === null)
    assert.ok(container.querySelector('[aria-label="设置"]') === null)
    assert.ok(container.querySelector('[aria-label="数据统计"]') === null)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="外观"]')!.click())
    assert.deepEqual(opened, [])
    assert.equal(container.querySelector('output')!.textContent, '/appearance')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
