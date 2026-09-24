import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import GitRemoteActions from '../src/components/git/GitRemoteActions'
import { gitApi, type GitStatus } from '../src/api/git'

test('remote actions choose a remote target and render a compact result notice', async () => {
  const { window } = installDomEnvironment()
  const original = { push: gitApi.push, remotes: gitApi.remotes }
  let args: unknown[] = [], refreshes = 0
  const status = { id: 'repo', branch: 'feat/xzr/canteen_job_person_fields', head: 'sha', upstream: 'origin/staging', ahead: 1, files: [], snapshot: 'review', active: false, operation: null } as unknown as GitStatus
  gitApi.push = async (...values) => { args = values; return status }
  gitApi.remotes = async () => ({ remotes: [
    { name: 'backup', url: 'git.example.com:team/repo.git', push_url: 'git.example.com:team/repo.git', branches: [{ name: 'release', head: 'abc' }] },
    { name: 'origin', url: 'github.com:team/repo.git', push_url: 'github.com:team/repo.git', branches: [{ name: 'staging', head: 'def' }] },
  ], upstream: { remote: 'origin', branch: 'staging' }, fetched_at: null })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const render = (s: GitStatus, readOnly = false) => <I18nProvider><GitRemoteActions status={s} readOnly={readOnly} onRefresh={async () => { refreshes++ }} onBusy={() => {}} /></I18nProvider>
  const push = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '推送')!
  try {
    await act(async () => root.render(render({ ...status, files: [{ path: 'new.txt', untracked: true } as GitStatus['files'][number]] })))
    assert.equal(push().disabled, false)
    assert.equal([...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.startsWith('拉取'))!.disabled, false)
    await act(async () => root.render(render(status, true)))
    assert.equal(push().disabled, true)
    await act(async () => root.render(render({ ...status, files: [{ path: 'new.txt', untracked: true } as GitStatus['files'][number]] })))
    assert.equal(push().disabled, false)
    assert.ok([...container.querySelectorAll('button')].some(b => b.textContent === '拉取'))
    await act(async () => push().click())
    const selects = container.querySelectorAll('select')
    assert.equal(selects.length, 1)
    assert.equal(container.querySelector<HTMLInputElement>('input[name="targetBranch"]')!.value, status.branch)
    await act(async () => { selects[0].value = 'backup'; selects[0].dispatchEvent(new Event('change', { bubbles: true })) })
    const target = container.querySelector<HTMLInputElement>('input[name="targetBranch"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(target, 'release')
      target.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const confirm = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '推送到远程')!
    await act(async () => confirm.click())
    assert.deepEqual(args, ['repo', status.branch, 'review', { remote: 'backup', targetBranch: 'release', setUpstream: false }])
    assert.equal(refreshes, 1)
    assert.match(container.textContent!, /推送完成/)
    assert.ok(container.querySelector('.git-remote-toast--success'))
  } finally { await act(async () => root.unmount()); gitApi.push = original.push; gitApi.remotes = original.remotes; container.remove(); await window.happyDOM.close() }
})
