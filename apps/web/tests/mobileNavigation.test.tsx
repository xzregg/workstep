import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import ResponsiveNavigation from '../src/components/ResponsiveNavigation'
import { I18nProvider } from '../src/i18n'

test('drawer opens, keeps a single navigation tree, closes after selection, and preserves its content across resize', async () => {
  const window = new Window({ width: 390, url: 'http://localhost/tasks' })
  Object.assign(globalThis, { window, document: window.document, history: window.history, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  let mounts = 0
  function NavigationContent() {
    useState(() => { mounts++; return 0 })
    const navigate = useNavigate()
    return <>
      <button onClick={() => navigate('/chat?session=one')}>会话一</button>
      <button onClick={() => navigate('/tasks?project=two', {
        state: { preserveNavigationDrawer: true },
      })}>项目二</button>
      <button onClick={() => navigate('/chat?session=next', {
        replace: true,
        state: { preserveNavigationDrawer: true },
      })}>删除后跳转</button>
    </>
  }
  function Surface() {
    const location = useLocation()
    return <><ResponsiveNavigation title="项目" onNew={() => {}}><NavigationContent /></ResponsiveNavigation><output>{location.pathname}</output></>
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<I18nProvider><MemoryRouter><Surface /></MemoryRouter></I18nProvider>))
  const menu = container.querySelector<HTMLButtonElement>('[aria-label="打开导航"]')!
  assert.ok(menu)
  await act(async () => menu.click())
  assert.equal(menu.getAttribute('aria-expanded'), 'true')
  const session = [...container.querySelectorAll('button')].find(x => x.textContent === '会话一')!
  await act(async () => session.click())
  assert.equal(container.querySelector('output')!.textContent, '/chat')
  assert.equal(menu.getAttribute('aria-expanded'), 'false')
  await act(async () => menu.click())
  const deleteNavigation = [...container.querySelectorAll('button')].find(x => x.textContent === '删除后跳转')!
  await act(async () => deleteNavigation.click())
  assert.equal(menu.getAttribute('aria-expanded'), 'true', 'delete replacement navigation must preserve the drawer')
  const project = [...container.querySelectorAll('button')].find(x => x.textContent === '项目二')!
  await act(async () => project.click())
  assert.equal(menu.getAttribute('aria-expanded'), 'true', 'project selection must preserve the drawer')
  await act(async () => { window.happyDOM.setWindowSize({ width: 1280, height: 900 }) })
  assert.equal(mounts, 1)
  assert.equal(container.querySelectorAll('aside').length, 1)
  await act(async () => root.unmount())
  await window.happyDOM.close()
})
