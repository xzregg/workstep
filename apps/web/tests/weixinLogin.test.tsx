import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import BotSettingsEditor from '../src/components/BotSettingsEditor'
import WeixinLoginPanel from '../src/components/WeixinLoginPanel'
import { useProjectStore } from '../src/stores/projectStore'

test('ClawBot QR authorization saves a receipt without exposing credentials', async () => {
  const { window } = installDomEnvironment()
  const originalFetch = globalThis.fetch, store = useProjectStore.getState()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ projects: [] })
  let saved = 0, payload: any
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/weixin/login') && init?.method === 'POST') return Response.json({ login_id: 'receipt', status: 'wait', qr_content: 'https://example.com/qr' })
    if (String(input).includes('/weixin/login/')) return Response.json({ login_id: 'receipt', status: 'confirmed', account_id: 'account', qr_content: '' })
    payload = JSON.parse(String(init?.body)); return Response.json({ id: 'b' })
  }
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><BotSettingsEditor platform="weixin" onSaved={() => { saved++ }} onCancel={() => {}} onDirtyChange={() => {}} onBusyChange={() => {}} /></I18nProvider>))
    assert.equal(container.querySelector('input[type="password"]'), null)
    const save = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '保存')!
    assert.equal(save().disabled, true)
    assert.equal(container.querySelector('select:not([required])'), null)
    assert.equal(container.querySelector('input[type="checkbox"]'), null)
    assert.equal(container.querySelector<HTMLInputElement>('input')!.value, 'ClawBot')
    await act(async () => useProjectStore.setState({ projects: [
      { id: 'other', name: '其他项目', type: 'local' },
      { id: 'p', name: '默认工作区', type: 'local', is_default_workspace: true },
    ] as any }))
    assert.equal(container.querySelector<HTMLSelectElement>('select[required]')!.value, 'p')
    assert.equal(save().disabled, true)
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '扫码连接')!.click())
    assert.match(container.textContent!, /扫码授权成功/)
    assert.equal(save().disabled, false)
    await act(async () => save().click())
    assert.equal(payload.login_id, 'receipt')
    assert.equal(payload.secret, undefined)
    assert.equal(payload.app_id, undefined)
    assert.equal(payload.platform, 'weixin')
    assert.equal(payload.name, 'ClawBot')
    assert.equal(payload.enabled, true)
    assert.equal(payload.default_project_id, 'p')
    assert.equal(saved, 1)
  } finally {
    await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch
    useProjectStore.setState(store); await window.happyDOM.close()
  }
})

test('closing ClawBot QR cancels the receipt and ignores a late confirmation', async () => {
  const { window } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  let finish: (value: Response) => void = () => {}, authorized = 0
  const cancelled: string[] = []
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'DELETE') { cancelled.push(String(input)); return Response.json({}) }
    if (init?.method === 'POST') return Response.json({ login_id: 'late', status: 'wait', qr_content: 'scan' })
    return new Promise(resolve => { finish = resolve })
  }
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><WeixinLoginPanel onAuthorized={id => { if (id) authorized++ }} onActiveChange={() => {}} /></I18nProvider>))
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '扫码连接')!.click())
    assert.ok(container.querySelector('svg'))
    await act(async () => root.unmount())
    await act(async () => finish(Response.json({ login_id: 'late', status: 'confirmed', account_id: 'a' })))
    assert.equal(authorized, 0)
    assert.ok(cancelled.some(url => url.endsWith('/late')))
  } finally {
    container.remove(); globalThis.fetch = originalFetch; await window.happyDOM.close()
  }
})

test('expired QR can refresh and failed requests preserve a retry action', async () => {
  const { window } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  let starts = 0, authorized = ''
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'DELETE') return Response.json({})
    if (init?.method === 'POST') {
      starts++
      if (starts === 2) return Response.json({ detail: '网络异常' }, { status: 502 })
      return Response.json({ login_id: `qr-${starts}`, status: 'wait', qr_content: 'scan' })
    }
    return Response.json({ login_id: `qr-${starts}`, status: starts === 1 ? 'expired' : 'confirmed', account_id: 'a' })
  }
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  const click = async () => act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => /扫码连接|刷新二维码/.test(button.textContent!))!.click())
  try {
    await act(async () => root.render(<I18nProvider><WeixinLoginPanel onAuthorized={id => { authorized = id }} onActiveChange={() => {}} /></I18nProvider>))
    await click()
    assert.match(container.textContent!, /二维码已过期/)
    assert.equal(container.querySelector('[role="img"]'), null)
    await click()
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /网络异常/)
    await click()
    assert.equal(authorized, 'qr-3')
    assert.match(container.textContent!, /扫码授权成功/)
  } finally {
    await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch; await window.happyDOM.close()
  }
})
