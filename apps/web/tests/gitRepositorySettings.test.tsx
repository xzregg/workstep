import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { gitApi } from '../src/api/git'
import GitRepositorySettings from '../src/components/git/GitRepositorySettings'

test('Git settings save commit identity and HTTPS credentials without displaying the secret', async () => {
  const { window } = installDomEnvironment()
  const original = { identity: gitApi.identity, credentials: gitApi.credentials, setIdentity: gitApi.setIdentity, setGlobalIdentity: gitApi.setGlobalIdentity, saveCredentials: gitApi.saveCredentials, clearCredentials: gitApi.clearCredentials }
  const saved: unknown[] = []
  const inventory = { remotes: [{ name: 'origin', url: 'https://git.example.test/team/repo.git', configured: false }] }
  gitApi.identity = async () => ({ name: 'Old Name', email: 'old@example.test' })
  gitApi.credentials = async () => inventory
  gitApi.setIdentity = async (_id, value) => { saved.push(value); return value }
  gitApi.setGlobalIdentity = async (_id, value) => { saved.push({ global: value }); return value }
  gitApi.saveCredentials = async (_id, remote, username, token) => { saved.push({ remote, username, token }); return { remotes: [{ ...inventory.remotes[0], configured: true }] } }
  gitApi.clearCredentials = async () => inventory
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const change = async (input: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  try {
    await act(async () => root.render(<I18nProvider><GitRepositorySettings id="repo" /></I18nProvider>))
    await change(container.querySelector<HTMLInputElement>('input[name="gitIdentityName"]')!, 'New Name')
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '保存提交身份')!.click())
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '保存为所有仓库共用')!.click())
    await change(container.querySelector<HTMLInputElement>('input[name="gitAuthUsername"]')!, 'alice')
    await change(container.querySelector<HTMLInputElement>('input[name="gitAuthToken"]')!, 'private-token')
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '保存凭据')!.click())
    assert.deepEqual(saved, [{ name: 'New Name', email: 'old@example.test' }, { global: { name: 'New Name', email: 'old@example.test' } }, { name: 'New Name', email: 'old@example.test' }, { remote: 'origin', username: 'alice', token: 'private-token' }])
    assert.equal(container.querySelector<HTMLInputElement>('input[name="gitAuthToken"]')!.value, '')
    assert.equal(container.textContent!.includes('private-token'), false)
    assert.match(container.textContent!, /此远程源已有凭据/)
  } finally {
    await act(async () => root.unmount())
    Object.assign(gitApi, original)
    container.remove()
    await window.happyDOM.close()
  }
})
