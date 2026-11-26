import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { engineApi, type EngineLoginState } from '../src/api/engine'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import EngineLoginControl from '../src/components/EngineLoginControl'

test('native login opens a browser link, submits a transient code and reports actual completion', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.getState().setLocale('zh-CN')
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const original = { loginStatus: engineApi.loginStatus, startLogin: engineApi.startLogin,
    submitLoginCode: engineApi.submitLoginCode, cancelLogin: engineApi.cancelLogin }
  let state: EngineLoginState | null = null
  const calls: unknown[] = []
  let changed = 0
  engineApi.loginStatus = async () => state
  engineApi.startLogin = async engine => {
    calls.push(['start', engine])
    return state = { id: 'native', phase: 'waiting_code', authorization_url: 'https://accounts.google.com/o/oauth2/auth?state=fixture', error: null }
  }
  engineApi.submitLoginCode = async (engine, id, code) => {
    calls.push(['code', engine, id, code])
    return state = { id, phase: 'succeeded', authorization_url: null, error: null }
  }
  try {
    await act(async () => root.render(<I18nProvider><EngineLoginControl engineId="native-test" active onAuthenticated={() => { changed++ }} /></I18nProvider>))
    assert.deepEqual(calls, [], 'opening settings never starts a login')
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    const link = container.querySelector<HTMLAnchorElement>('a')!
    assert.equal(link.target, '_blank')
    assert.match(link.href, /^https:\/\/accounts.google.com\//)
    const input = container.querySelector<HTMLInputElement>('input')!
    assert.equal(input.type, 'password')
    assert.equal(input.autocomplete, 'off')
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!
    assert.equal(submit.disabled, true)
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'test-code')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await act(async () => submit.click())
    assert.deepEqual(calls, [['start', 'native-test'], ['code', 'native-test', 'native', 'test-code']])
    assert.match(container.textContent || '', /登录成功/)
    assert.equal(changed, 1)
    assert.equal(container.querySelector('input') === null, true)
    assert.equal(container.textContent?.includes('test-code'), false)
    assert.equal(Object.values(window.localStorage).some(value => String(value).includes('test-code')), false)
  } finally {
    Object.assign(engineApi, original)
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('recovering an in-progress login can cancel it and handles network errors without restarting', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.getState().setLocale('zh-CN')
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { loginStatus: engineApi.loginStatus, cancelLogin: engineApi.cancelLogin }
  let fail = true, cancelled = 0
  let recovered: EngineLoginState = { id:'pending', phase:'waiting_code', authorization_url:'https://accounts.google.com/o/oauth2/auth', error:null }
  engineApi.loginStatus = async () => {
    if (fail) throw new Error('offline')
    return recovered
  }
  engineApi.cancelLogin = async (_engine, id) => {
    assert.equal(id, 'pending')
    cancelled++
    return recovered = { id, phase:'cancelled', authorization_url:null, error:null }
  }
  try {
    await act(async () => root.render(<I18nProvider><EngineLoginControl engineId="test" active onAuthenticated={() => {}} /></I18nProvider>))
    assert.match(document.body.textContent || '', /offline/)
    assert.equal([...document.querySelectorAll('button')].find(b => b.textContent === '登录账号'), undefined)
    fail = false
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '重试')!.click())
    assert.equal(document.querySelectorAll('input').length, 1)
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '取消登录')!.click())
    assert.equal(cancelled, 1)
    assert.match(document.body.textContent || '', /已取消登录/)
  } finally {
    Object.assign(engineApi, original)
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
