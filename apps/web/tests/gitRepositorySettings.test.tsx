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
  const original = { identity: gitApi.identity, credentials: gitApi.credentials, setIdentity: gitApi.setIdentity, setGlobalIdentity: gitApi.setGlobalIdentity, saveHostCredentials: gitApi.saveHostCredentials, clearHostCredentials: gitApi.clearHostCredentials }
  const saved: unknown[] = []
  const inventory = { remotes: [{ name: 'origin', url: 'git@git.example.test:team/repo.git', push_url: 'https://gitlab.base.packertec.com/team/repo.git', configured: false }], hosts: [] as string[] }
  gitApi.identity = async () => ({ name: 'Old Name', email: 'old@example.test' })
  gitApi.credentials = async () => inventory
  gitApi.setIdentity = async (_id, value) => { saved.push(value); return value }
  gitApi.setGlobalIdentity = async (_id, value) => { saved.push({ global: value }); return value }
  gitApi.saveHostCredentials = async (host, username, token) => { saved.push({ host, username, token }); return { hosts: [host] } }
  gitApi.clearHostCredentials = async () => ({ hosts: [] })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const change = async (input: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  try {
    await act(async () => root.render(<I18nProvider><GitRepositorySettings id="repo" /></I18nProvider>))
    assert.equal(container.querySelector<HTMLInputElement>('input[name="gitAuthHost"]')!.value, 'gitlab.base.packertec.com')
    await change(container.querySelector<HTMLInputElement>('input[name="gitIdentityName"]')!, 'New Name')
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '保存提交身份')!.click())
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '保存为所有仓库共用')!.click())
    await change(container.querySelector<HTMLInputElement>('input[name="gitAuthUsername"]')!, 'alice')
    await change(container.querySelector<HTMLInputElement>('input[name="gitAuthToken"]')!, 'private-token')
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '保存凭据')!.click())
    assert.deepEqual(saved, [{ name: 'New Name', email: 'old@example.test' }, { global: { name: 'New Name', email: 'old@example.test' } }, { name: 'New Name', email: 'old@example.test' }, { host: 'gitlab.base.packertec.com', username: 'alice', token: 'private-token' }])
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

test('Git settings allow entering a host when the selected repository has no HTTPS remote', async () => {
  const { window } = installDomEnvironment()
  const original = { identity: gitApi.identity, credentials: gitApi.credentials, saveHostCredentials: gitApi.saveHostCredentials }
  let savedHost = ''
  gitApi.identity = async () => ({ name: '', email: '' })
  gitApi.credentials = async () => ({ remotes: [], hosts: [] })
  gitApi.saveHostCredentials = async (host) => { savedHost = host; return { hosts: [host] } }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><GitRepositorySettings id="repo" /></I18nProvider>))
    const host = container.querySelector<HTMLInputElement>('input[name="gitAuthHost"]')!
    const username = container.querySelector<HTMLInputElement>('input[name="gitAuthUsername"]')!
    const token = container.querySelector<HTMLInputElement>('input[name="gitAuthToken"]')!
    for (const [input, value] of [[host, 'gitlab.base.packertec.com'], [username, 'alice'], [token, 'token']] as const) {
      await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
    }
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '保存凭据')!.click())
    assert.equal(savedHost, 'gitlab.base.packertec.com')
  } finally {
    await act(async () => root.unmount())
    Object.assign(gitApi, original)
    container.remove()
    await window.happyDOM.close()
  }
})

test('Git settings stay visible while an older daemon omits credential hosts', async () => {
  const { window } = installDomEnvironment()
  const original = { identity: gitApi.identity, credentials: gitApi.credentials }
  gitApi.identity = async () => ({ name: 'Local User', email: 'local@example.test' })
  gitApi.credentials = async () => ({ remotes: [{ name: 'origin', url: 'https://git.example.test/team/repo.git', configured: false }] }) as Awaited<ReturnType<typeof gitApi.credentials>>
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><GitRepositorySettings id="repo" /></I18nProvider>))
    assert.equal(container.querySelector<HTMLInputElement>('input[name="gitAuthHost"]')?.value, 'git.example.test')
    assert.match(container.textContent!, /HTTPS 远程登录/)
  } finally {
    await act(async () => root.unmount())
    Object.assign(gitApi, original)
    container.remove()
    await window.happyDOM.close()
  }
})

test('Git settings suggest the HTTPS host for an HTTP remote', async () => {
  const { window } = installDomEnvironment()
  const original = { identity: gitApi.identity, credentials: gitApi.credentials }
  gitApi.identity = async () => ({ name: '', email: '' })
  gitApi.credentials = async () => ({ remotes: [{ name: 'origin', url: 'http://git.example.test/team/repo.git', push_url: 'http://git.example.test/team/repo.git', configured: true }], hosts: ['git.example.test'] })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><GitRepositorySettings id="repo" /></I18nProvider>))
    assert.equal(container.querySelector<HTMLInputElement>('input[name="gitAuthHost"]')?.value, 'git.example.test')
    assert.equal(container.querySelector('datalist option')?.getAttribute('value'), 'git.example.test')
  } finally {
    await act(async () => root.unmount())
    Object.assign(gitApi, original)
    container.remove()
    await window.happyDOM.close()
  }
})

test('remote project settings save repository identity without loading host credentials', async () => {
  const { window } = installDomEnvironment()
  const { GitApiContext } = await import('../src/components/git/GitApiContext')
  let credentialReads = 0
  let saved = 0
  const api = { ...gitApi,
    identity: async () => ({ name: 'Remote User', email: 'remote@example.test' }),
    credentials: async () => { credentialReads++; return { remotes: [], hosts: [] } },
    setIdentity: async (_id: string, value: { name: string; email: string }) => { saved++; return value },
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><GitApiContext.Provider value={{ api, shared: false, projectScoped: true, readOnly: false, browseWorkspace: async () => { throw new Error('unused') } }}><GitRepositorySettings id="remote-tree" /></GitApiContext.Provider></I18nProvider>))
    assert.equal(credentialReads, 0)
    assert.equal(container.querySelector('input[name="gitAuthHost"]'), null)
    assert.equal(container.querySelectorAll('button').length, 1)
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    assert.equal(saved, 1)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
