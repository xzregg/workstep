import { installDomEnvironment } from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import SettingsPage from '../src/pages/SettingsPage'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { engineApi } from '../src/api/client'
import { decisionModelsApi, type DecisionStatus } from '../src/api/decisionModels'

for (const exit of ['close', 'section']) test(`decision configuration protects unsaved ${exit} and accepts discard`, async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const resource = { stage: 'idle', installed: false, downloaded_bytes: 0, total_bytes: null, error: '', path: '/demo', size_bytes: null }
  const old = { fetch: globalThis.fetch, status: decisionModelsApi.status, engines: engineApi.list }
  globalThis.fetch = async input => Response.json(String(input).includes('/provider/') ? { providers: [], types: [] } : [])
  engineApi.list = async () => ({ engines: [] })
  decisionModelsApi.status = async (): Promise<DecisionStatus> => ({ settings: { mode: 'managed', base_url: '', model: '', has_api_key: false }, root: '/demo', platform: 'test', worker: 'stopped', resources: { runtime: resource, model: resource } })
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container); let closed = 0
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)!
  const leave = () => exit === 'close' ? container.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.click() : button('供应商').click()
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><SettingsPage initialSection="decision" onClose={() => { closed++ }} /></I18nProvider></MemoryRouter>))
    await act(async () => button('本地服务连接已启动的本地服务').click())
    await act(async () => leave())
    assert.equal(closed, 0)
    const dialog = () => container.querySelector('[aria-label="放弃未保存的决策模型配置？"]')!
    assert.ok(dialog())
    await act(async () => [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '取消')!.click())
    assert.ok(document.getElementById('decision-endpoint'))
    await act(async () => leave())
    await act(async () => dialog().querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click())
    assert.equal(closed, exit === 'close' ? 1 : 0)
    if (exit === 'section') assert.equal(document.querySelector('.decision-settings'), null)
  } finally {
    await act(async () => root.unmount()); globalThis.fetch = old.fetch; decisionModelsApi.status = old.status; engineApi.list = old.engines; await window.happyDOM.close()
  }
})
