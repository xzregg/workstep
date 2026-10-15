import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import ShareDialog from '../src/components/ShareDialog'
import { forgetTaskShareKey } from '../../../packages/gateway-ui/src/taskShareDefaults'
import { I18nProvider, useLocaleStore } from '../src/i18n'

for (const gateway of [false, true]) test(`share dialog focuses its container instead of password: gateway=${gateway}`, async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const element = document.body.appendChild(document.createElement('div'))
  const root = createRoot(element)
  const api = { get: async () => null, create: async () => { throw new Error('unused') }, revoke: async () => {} }
  try {
    await act(async () => root.render(<I18nProvider><ShareDialog open gateway={gateway} taskId="task-1" projectId="p-1" api={api} onClose={() => {}} /></I18nProvider>))
    const dialog = element.querySelector('[role="dialog"]')
    const password = element.querySelector<HTMLInputElement>('input[name="share-access-key"]')
    assert.ok(dialog)
    assert.ok(password)
    assert.equal(document.activeElement, dialog)
    password.focus()
    await act(async () => root.render(<I18nProvider><ShareDialog open gateway={gateway} taskId="task-1" projectId="p-1" api={api} onClose={() => {}} /></I18nProvider>))
    assert.equal(document.activeElement, password)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


for (const gateway of [false, true]) test(`share defaults and clipboard include a generated key: gateway=${gateway}`, async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const element = document.body.appendChild(document.createElement('div'))
  const root = createRoot(element)
  let submitted: any[] = []
  let copied = ''
  let closed = false
  let saved: any = null
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied = value } } })
  const api = { get: async () => saved, create: async (...args: any[]) => {
    submitted = args
    saved = { id: 'share-default-' + gateway, task_id: 'task', token: 'default-token', url: 'https://gateway.test/share/default-token',
      access_password: args[2], mode: args[4], title: null, has_password: true, revoked: false, created_at: new Date().toISOString(), revoked_at: null }
    return saved
  }, revoke: async () => {} }
  const render = (open = true) => root.render(<I18nProvider><ShareDialog open={open} gateway={gateway} taskId="task" taskTitle="示例任务" projectId="project" api={api} onClose={() => { closed = true }} /></I18nProvider>)
  try {
    await act(async () => render())
    const password = element.querySelector<HTMLInputElement>('input[name="share-access-key"]')!
    const expiry = element.querySelector<HTMLInputElement>('input[type="datetime-local"]')!
    assert.ok(password.value.length >= 16)
    assert.ok(expiry, 'all share entry points expose expiry')
    assert.ok(Math.abs(new Date(expiry.value).getTime() - Date.now() - 7 * 86400000) < 60000)
    const key = password.value
    await act(async () => (element.querySelector('button[aria-label="关闭"]') as HTMLButtonElement).click())
    assert.equal(closed, true, 'generated defaults are not unsaved user edits')
    await act(async () => ([...element.querySelectorAll('button')].find(button => button.textContent?.trim() === '生成分享链接')!).click())
    assert.equal(submitted[2], key)
    assert.equal(submitted[5], new Date(expiry.value).toISOString())
    await act(async () => ([...element.querySelectorAll('button')].find(button => button.textContent?.trim() === '复制链接和密钥')!).click())
    assert.ok(copied.startsWith('示例任务\n访问地址：'))
    assert.match(copied, /\/share\/default-token/)
    assert.match(copied, new RegExp('访问密码：' + key))
    forgetTaskShareKey(saved.id) // Simulate reopening without any in-memory credential cache.
    await act(async () => render(false))
    await act(async () => render())
    await act(async () => ([...element.querySelectorAll('button')].find(button => button.textContent?.trim() === '复制链接和密钥')!).click())
    assert.match(copied, new RegExp('访问密码：' + key))
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

for (const interactive of [false, true]) test(`Gateway login replaces the key, enforces interactive login, and recopies: interactive=${interactive}`, async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const element = document.body.appendChild(document.createElement('div'))
  const root = createRoot(element)
  let submitted: any[] = [], saved: any = null, copied = ''
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied = value } } })
  const api = { get: async () => saved, create: async (...args: any[]) => {
    submitted = args
    return saved = { id: 'login-share', token: '', task_id: 'task', url: 'https://gateway.test/share/login',
      title: null, mode: 'interactive', require_login: true, has_password: false, access_password: '',
      revoked: false, created_at: '', revoked_at: null }
  }, revoke: async () => {} }
  const render = (open = true) => root.render(<I18nProvider><ShareDialog open={open} gateway taskId="task" taskTitle="示例任务" projectId="p" api={api} onClose={() => {}} /></I18nProvider>)
  try {
    await act(async () => render())
    const toggle = element.querySelector<HTMLInputElement>('input[aria-label="验证网关登录"]')!
    assert.ok(toggle)
    if (interactive) await act(async () => [...element.querySelectorAll('button')].find(b => b.textContent?.trim() === '可交互')!.click())
    else await act(async () => toggle.click())
    assert.equal(toggle.checked, true)
    assert.equal(toggle.disabled, interactive)
    assert.equal(element.querySelector('input[name="share-access-key"]'), null)
    await act(async () => [...element.querySelectorAll('button')].find(b => b.textContent?.trim() === '生成分享链接')!.click())
    assert.equal(submitted[2], null)
    assert.equal(submitted[6], true)
    await act(async () => render(false))
    await act(async () => render())
    await act(async () => [...element.querySelectorAll('button')].find(b => b.textContent?.trim() === '复制链接')!.click())
    assert.equal(copied, '示例任务\n访问地址：https://gateway.test/share/login')
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})
