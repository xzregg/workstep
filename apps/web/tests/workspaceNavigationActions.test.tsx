import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import WorkspaceNavigationActions from '../src/components/WorkspaceNavigationActions'

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
