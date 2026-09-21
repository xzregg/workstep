import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import GitRemoteActions from '../src/components/git/GitRemoteActions'
import { gitApi, type GitStatus } from '../src/api/git'

test('header Pull and Push reject dirty files and push a clean reviewed current branch', async () => {
  const { window } = installDomEnvironment()
  const original = gitApi.push
  let args: unknown[] = [], refreshes = 0
  const status = { id: 'repo', branch: 'main', head: 'sha', upstream: 'origin/main', files: [], snapshot: 'review', active: false, operation: null } as unknown as GitStatus
  gitApi.push = async (...values) => { args = values; return status }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const render = (s: GitStatus, readOnly = false) => <I18nProvider><GitRemoteActions status={s} readOnly={readOnly} onRefresh={async () => { refreshes++ }} onBusy={() => {}} /></I18nProvider>
  const push = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Push')!
  try {
    await act(async () => root.render(render({ ...status, files: [{ path: 'new.txt', untracked: true } as GitStatus['files'][number]] })))
    assert.equal(push().disabled, true)
    await act(async () => root.render(render(status, true)))
    assert.equal(push().disabled, true)
    await act(async () => root.render(render(status)))
    assert.equal(push().disabled, false)
    assert.ok([...container.querySelectorAll('button')].some(b => b.textContent === 'Pull'))
    await act(async () => push().click())
    assert.deepEqual(args, ['repo', 'main', 'review'])
    assert.equal(refreshes, 1)
    assert.match(container.textContent!, /Push 完成/)
  } finally { await act(async () => root.unmount()); gitApi.push = original; container.remove(); await window.happyDOM.close() }
})
