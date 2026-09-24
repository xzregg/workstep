import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import GitMergeActions from '../src/components/git/GitMergeActions'
import { gitApi, type GitStatus } from '../src/api/git'

test('branch row selection opens the existing merge panel with its direction and branch selected', async () => {
  const { window } = installDomEnvironment()
  const original = gitApi.branches
  const status = { id: 'repo', branch: 'main', head: 'abc', files: [], snapshot: 'review', active: false, operation: null } as GitStatus
  gitApi.branches = async () => ({ branches: [
    { name: 'main', head: 'abc', worktree_id: 'repo', path: '/repo' },
    { name: 'dev', head: 'def', worktree_id: null, path: null },
  ] })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const render = async (request: { direction: 'intoCurrent' | 'intoTarget'; branch: string }) => act(async () => root.render(<I18nProvider><GitMergeActions status={status} readOnly={false} request={request} onRefresh={async () => {}} onBusy={() => {}} /></I18nProvider>))
  try {
    await render({ direction: 'intoCurrent', branch: 'dev' })
    assert.equal(container.querySelectorAll('select')[0].value, 'intoCurrent')
    assert.equal(container.querySelectorAll('select')[1].value, 'local\0\0dev')
    await render({ direction: 'intoTarget', branch: 'dev' })
    assert.equal(container.querySelectorAll('select')[0].value, 'intoTarget')
    assert.equal(container.querySelectorAll('select')[1].value, 'dev')
  } finally { await act(async () => root.unmount()); gitApi.branches = original; container.remove(); await window.happyDOM.close() }
})

test('merge picker sends the chosen remote branch into the current branch', async () => {
  const { window } = installDomEnvironment()
  const original = { branches: gitApi.branches, merge: gitApi.merge }
  const status = { id: 'repo', branch: 'main', head: 'abc', files: [], snapshot: 'review', active: false, operation: null } as GitStatus
  let args: unknown[] = [], refreshed = 0
  gitApi.branches = async () => ({ branches: [{ name: 'main', head: 'abc', worktree_id: 'repo', path: '/repo' }, { name: 'feature', head: 'def', worktree_id: null, path: null }], remote_branches: [{ name: 'origin/release', remote: 'origin', branch: 'release', head: 'ghi' }] })
  gitApi.merge = async (...values) => { args = values; return status }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><GitMergeActions status={status} readOnly={false} onRefresh={async () => { refreshed++ }} onBusy={() => {}} /></I18nProvider>))
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    const select = container.querySelectorAll('select')[1]
    assert.deepEqual([...select.options].map(option => option.textContent), ['Source branch', 'feature', 'origin/release'])
    await act(async () => { select.value = 'remote\0origin\0release'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Merge branch')!.click())
    assert.deepEqual(args, ['repo', 'main', 'review', 'release', 'origin'])
    assert.equal(refreshed, 1)
  } finally { await act(async () => root.unmount()); gitApi.branches = original.branches; gitApi.merge = original.merge; container.remove(); await window.happyDOM.close() }
})

test('merge allows dirty files and warns that Git will protect overlapping changes', async () => {
  const { window } = installDomEnvironment()
  const original = gitApi.branches
  const status = { id: 'repo', branch: 'main', head: 'abc', files: [{ path: 'draft.txt' }], snapshot: 'review', active: false, operation: null } as GitStatus
  gitApi.branches = async () => ({ branches: [{ name: 'feature', head: 'def', worktree_id: null, path: null }] })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><GitMergeActions status={status} readOnly={false} onRefresh={async () => {}} onBusy={() => {}} /></I18nProvider>))
    const button = container.querySelector<HTMLButtonElement>('button')!
    assert.equal(button.disabled, false)
    await act(async () => button.click())
    assert.match(container.textContent || '', /Git refuses a merge/)
    const select = container.querySelectorAll('select')[1]
    await act(async () => { select.value = 'local\0\0feature'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    assert.equal([...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Merge branch')!.disabled, false)
  } finally { await act(async () => root.unmount()); gitApi.branches = original; container.remove(); await window.happyDOM.close() }
})

test('merge picker sends the current branch into a chosen local target', async () => {
  const { window } = installDomEnvironment()
  const original = { branches: gitApi.branches, mergeInto: gitApi.mergeInto, pushBranch: gitApi.pushBranch }
  const status = { id: 'repo', branch: 'feature', head: 'abc', files: [], snapshot: 'review', active: false, operation: null } as GitStatus
  let args: unknown[] = [], pushArgs: unknown[] = []
  gitApi.branches = async () => ({ branches: [{ name: 'feature', head: 'abc', worktree_id: 'repo', path: '/repo' }, { name: 'dev', head: 'def', worktree_id: null, path: null }] })
  gitApi.mergeInto = async (...values) => { args = values; return { target: 'dev', head: 'abc', updated: true, push_available: true } }
  gitApi.pushBranch = async (...values) => { pushArgs = values; return { branch: 'dev', head: 'abc' } }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><GitMergeActions status={status} readOnly={false} onRefresh={async () => {}} onBusy={() => {}} /></I18nProvider>))
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    const direction = container.querySelectorAll('select')[0]
    await act(async () => { direction.value = 'intoTarget'; direction.dispatchEvent(new Event('change', { bubbles: true })) })
    const target = container.querySelectorAll('select')[1]
    await act(async () => { target.value = 'dev'; target.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Merge branch')!.click())
    assert.deepEqual(args, ['repo', 'feature', 'review', 'dev'])
    assert.deepEqual(pushArgs, [])
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Push dev')!.click())
    assert.deepEqual(pushArgs, ['repo', 'dev', 'abc'])
  } finally { await act(async () => root.unmount()); gitApi.branches = original.branches; gitApi.mergeInto = original.mergeInto; gitApi.pushBranch = original.pushBranch; container.remove(); await window.happyDOM.close() }
})
