import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import SettingsPage from '../src/pages/SettingsPage'
import { engineApi } from '../src/api/client'
import { useProjectStore } from '../src/stores/projectStore'

for (const exit of ['close', 'escape', 'backdrop', 'section']) {
  test(`unsaved channel configuration guards settings ${exit} and preserves a cancelled draft`, async () => {
    const { window } = installDomEnvironment()
    const previousFetch = globalThis.fetch, previousProjects = useProjectStore.getState()
    const previousEngines = engineApi.list
    useLocaleStore.setState({ locale: 'zh-CN' })
    useProjectStore.setState({ projects: [], fetchProjects: async () => {} })
    engineApi.list = async () => ({ engines: [] })
    globalThis.fetch = async input => Response.json(String(input).includes('/provider/') ? { providers: [] } : [])
    let closed = 0
    const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
    const attemptExit = async () => act(async () => {
      if (exit === 'close') container.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.click()
      else if (exit === 'escape') document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      else if (exit === 'backdrop') container.querySelector('.settings-dialog-overlay')!.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
      else [...container.querySelectorAll<HTMLButtonElement>('.settings-nav-button')].find(button => button.textContent === '供应商')!.click()
    })
    const draft = () => container.querySelector<HTMLInputElement>('.bot-settings-form input')!
    try {
      await act(async () => root.render(<MemoryRouter><I18nProvider><SettingsPage initialSection="channels" onClose={() => { closed++ }} /></I18nProvider></MemoryRouter>))
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(draft(), '尚未保存的机器人')
        draft().dispatchEvent(new window.Event('input', { bubbles: true }))
      })
      await attemptExit()
      assert.equal(closed, 0)
      const dialog = () => document.querySelector('[role="dialog"][aria-label="放弃未保存的机器人配置？"]')!
      assert.ok(dialog())
      await act(async () => [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '取消')!.click())
      assert.equal(draft().value, '尚未保存的机器人')
      assert.equal(closed, 0)
      await attemptExit()
      await act(async () => dialog().querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click())
      if (exit === 'section') {
        assert.equal(container.querySelector('.bot-settings-form'), null)
        assert.equal(closed, 0)
        await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.settings-nav-button')].find(button => button.textContent === '渠道机器人')!.click())
        assert.equal(draft().value, '')
        await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.click())
      }
      assert.equal(closed, 1, 'confirming discard permits exit; a clean remount must not retain the guard')
    } finally {
      await act(async () => root.unmount()); container.remove()
      globalThis.fetch = previousFetch; engineApi.list = previousEngines; useProjectStore.setState(previousProjects)
      await window.happyDOM.close()
    }
  })
}
