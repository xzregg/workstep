import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import AppearanceSettings from '../src/pages/AppearanceSettings'
import { loadFontSizePreference } from '../src/utils/fontSizePreference'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { skinsApi } from '../src/api/skins'
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'

for (const projectScoped of [false, true]) test(`appearance settings embeds the center for ${projectScoped ? 'project' : 'device'} access with the correct creation boundary`, async () => {
  const { window } = installDomEnvironment()
  Object.defineProperty(globalThis, 'history', { configurable: true, value: window.history })
  window.happyDOM.setURL('http://d-device.localhost:8700/')
  useLocaleStore.setState({ locale: 'zh-CN' })
  const oldList = skinsApi.list
  skinsApi.list = async () => []
  useGatewaySessionStore.setState({ session: { device_id: 'device', device_name: 'PC', username: 'Tester', gateway_url: 'http://localhost:8700', project_id: projectScoped ? 'platform' : null, host_project_id: projectScoped ? 'project' : null, access_level: projectScoped ? 'read' : null, task_create: false, share_create: false, can_manage_project_access: false } })
  const element = document.body.appendChild(document.createElement('div')), root = createRoot(element)
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><AppearanceSettings /></I18nProvider></MemoryRouter>))
    assert.ok(document.querySelector('.skin-settings-workspace'))
    const basics = element.querySelector('.settings-appearance-font')!
    const library = element.querySelector('.skin-settings-workspace')!
    assert.ok(basics.compareDocumentPosition(library) & window.Node.DOCUMENT_POSITION_FOLLOWING)
    const language = element.querySelector<HTMLSelectElement>('#appearance-language')!
    assert.ok(language)
    assert.equal(language.value, 'zh-CN')
    await act(async () => { language.value = 'en-US'; language.dispatchEvent(new window.Event('change', { bubbles: true })) })
    assert.equal(useLocaleStore.getState().locale, 'en-US')
    assert.equal(document.documentElement.lang, 'en-US')
    const family = element.querySelector<HTMLSelectElement>('#appearance-font-family')!
    assert.ok(family)
    await act(async () => { family.value = 'pingfang'; family.dispatchEvent(new window.Event('change', { bubbles: true })) })
    assert.match(document.documentElement.style.getPropertyValue('--font-body'), /PingFang SC/)
    assert.equal(window.localStorage.getItem('workstep.fontFamily'), 'pingfang')
    const hasCreate = [...document.querySelectorAll('button')].some(button => button.textContent?.includes('聊天制作皮肤'))
    assert.equal(hasCreate, !projectScoped)
    assert.ok(document.querySelector('.skin-settings-preview-stage'))
    const large = [...element.querySelectorAll<HTMLButtonElement>('.settings-appearance-font button')].find(button => /^大$|^Large$/.test(button.textContent ?? ''))!
    await act(async () => large.click())
    assert.equal(loadFontSizePreference(), 'large')
    assert.equal(document.documentElement.dataset.fontSize, 'large')
  } finally {
    await act(async () => root.unmount()); element.remove(); skinsApi.list = oldList
    useLocaleStore.setState({ locale: 'zh-CN' }); useGatewaySessionStore.setState({ session: null }); await window.happyDOM.close()
  }
})
