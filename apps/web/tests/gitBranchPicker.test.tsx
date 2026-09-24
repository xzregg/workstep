import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import GitBranchPicker from '../src/components/git/GitBranchPicker'
import { gitApi, type GitStatus, type GitBranch } from '../src/api/git'

test('branch picker filters fuzzy names, shows upstream state and explicitly fetches or pulls current branch', async () => {
  const { window } = installDomEnvironment()
  const original = { ...gitApi }
  const main: GitBranch = { name: 'main', head: 'abc', worktree_id: 'repo', path: '/repo', upstream: 'origin/main', ahead: 0, behind: 0 }
  const feature = { ...main, name: 'feature/payment-report', worktree_id: null, upstream: 'origin/feature/payment-report', behind: 2 }
  const state = { id: 'repo', branch: 'main', files: [], active: false, operation: null, snapshot: 'review' } as unknown as GitStatus
  let fetched = 0, changed = 0
  let pulled: unknown[] = [], switched: unknown[] = [], advanced: unknown[] = []
  const remoteBranch = { name: 'upstream/remote-only', remote: 'upstream', branch: 'remote-only', head: 'remote' }
  gitApi.branches = async () => ({ branches: [main, feature], remote_branches: [remoteBranch] })
  gitApi.fetch = async () => { fetched++; return { branches: [{ ...main, behind: 1 }, feature], remote_branches: [remoteBranch], fetched_at: 1700000000 } }
  gitApi.pull = async (...args) => { pulled = args; return state }
  gitApi.switch = async (...args) => { switched = args; return state }
  gitApi.advance = async (...args) => { advanced = args; return { branches: [{ ...main, behind: 1 }, { ...feature, behind: 0 }], remote_branches: [] } }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const click = async (label: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label)!.click())
  try {
    await act(async () => root.render(<I18nProvider><GitBranchPicker status={state} onLocate={() => {}} onChanged={async () => { changed++ }} /></I18nProvider>))
    assert.equal(container.querySelector('.git-branch-list')?.getAttribute('role'), 'listbox')
    assert.equal(container.querySelectorAll('.git-branch-row[role="option"]').length, 2)
    assert.doesNotMatch(container.textContent!, /remote-only/)
    assert.equal(fetched, 0)
    assert.match(container.textContent!, /已同步/)
    assert.match(container.textContent!, /落后 2/)
    const input = container.querySelector<HTMLInputElement>('input')!
    const search = async (value: string) => act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await search('ft pay rpt')
    assert.equal(container.querySelectorAll('.git-branch-row').length, 1)
    assert.match(container.querySelector('.git-branch-row')!.textContent!, /feature\/payment-report/)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="拉取 feature/payment-report 的 2 个更新"]')!.click())
    assert.deepEqual(advanced, ['repo', 'feature/payment-report', 'review'])
    await search('zzzzzz')
    assert.match(container.textContent!, /没有匹配/)
    await search('')
    await click('拉取分支')
    assert.equal(fetched, 1)
    assert.match(container.textContent!, /落后 1/)
    assert.match(container.textContent!, /upstream\/remote-only/)
    await search('remote only')
    await click('切换分支')
    assert.deepEqual(switched, ['repo', 'remote-only', 'review', 'upstream'])
    await search('')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="拉取 main 的 1 个更新"]')!.click())
    assert.deepEqual(pulled, ['repo', 'main', 'review'])
    assert.equal(changed, 2)
    await act(async () => root.render(<I18nProvider><GitBranchPicker status={{ ...state, active: true }} onLocate={() => {}} onChanged={async () => {}} /></I18nProvider>))
    assert.equal(container.querySelector<HTMLButtonElement>('[aria-label="拉取 main 的 1 个更新"]')!.disabled, true)
  } finally { await act(async () => root.unmount()); Object.assign(gitApi, original); container.remove(); await window.happyDOM.close() }
})

test('dirty working files do not disable a Git-safe branch switch', async () => {
  const { window } = installDomEnvironment()
  const original = { ...gitApi }
  const current: GitBranch = { name: 'main', head: 'abc', worktree_id: 'repo', path: '/repo', upstream: 'origin/main', ahead: 0, behind: 1 }
  const target: GitBranch = { name: 'other', head: 'abc', worktree_id: null, path: null }
  const state = { id: 'repo', branch: 'main', files: [{ path: 'dirty.txt' }], active: false, operation: null, snapshot: 'dirty-review' } as unknown as GitStatus
  let switched: unknown[] = []
  gitApi.branches = async () => ({ branches: [current, target] })
  gitApi.switch = async (...args) => { switched = args; return state }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><GitBranchPicker status={state} onLocate={() => {}} onChanged={async () => {}} /></I18nProvider>))
    assert.equal(container.querySelector<HTMLButtonElement>('[aria-label="拉取 main 的 1 个更新"]')!.disabled, false)
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '切换分支')!
    assert.equal(button.disabled, false)
    await act(async () => button.click())
    assert.deepEqual(switched, ['repo', 'other', 'dirty-review', undefined])
  } finally { await act(async () => root.unmount()); Object.assign(gitApi, original); container.remove(); await window.happyDOM.close() }
})

test('creates a named branch from the selected local or fetched remote base without switching', async () => {
  const { window } = installDomEnvironment()
  const original = { branches: gitApi.branches, fetch: gitApi.fetch, createBranch: gitApi.createBranch }
  const current: GitBranch = { name: 'main', head: 'a'.repeat(40), worktree_id: 'repo', path: '/repo' }
  const base: GitBranch = { name: 'dev', head: 'b'.repeat(40), worktree_id: null, path: null }
  const remote = { name: 'origin/release', remote: 'origin', branch: 'release', head: 'c'.repeat(40) }
  const status = { id: 'repo', branch: 'main', files: [], active: false, operation: null, snapshot: 'review' } as unknown as GitStatus
  let created: unknown[] = []
  gitApi.branches = async () => ({ branches: [current, base] })
  gitApi.fetch = async () => ({ branches: [current, base], remote_branches: [remote] })
  gitApi.createBranch = async (...args) => { created = args; return { branches: [current, base, { name: args[1], head: args[3], worktree_id: null, path: null }], remote_branches: [remote] } }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><GitBranchPicker status={status} onLocate={() => {}} onChanged={async () => {}} /></I18nProvider>))
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'New branch')!.click())
    const name = container.querySelector<HTMLInputElement>('input[name="newBranch"]')!
    const baseSelect = container.querySelector<HTMLSelectElement>('select[name="baseBranch"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(name, 'topic/dev'); name.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { baseSelect.value = 'local\0dev'; baseSelect.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Create branch')!.click())
    assert.deepEqual(created, ['repo', 'topic/dev', 'dev', base.head, 'review', undefined])
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '拉取分支')!.click())
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'New branch')!.click())
    const nextName = container.querySelector<HTMLInputElement>('input[name="newBranch"]')!
    const nextBase = container.querySelector<HTMLSelectElement>('select[name="baseBranch"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(nextName, 'topic/release'); nextName.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { nextBase.value = 'remote\0origin\0release'; nextBase.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Create branch')!.click())
    assert.deepEqual(created, ['repo', 'topic/release', 'release', remote.head, 'review', 'origin'])
  } finally { await act(async () => root.unmount()); Object.assign(gitApi, original); container.remove(); await window.happyDOM.close() }
})

test('branch search ranks an exact branch name before weaker upstream and prefix matches', async () => {
  const { window } = installDomEnvironment()
  const original = gitApi.branches
  const branch = (name: string, upstream: string | null): GitBranch => ({ name, head: name, worktree_id: null, path: null, upstream })
  gitApi.branches = async () => ({ branches: [
    branch('master', 'origin/staging-mirror'),
    branch('staging-backup', 'origin/staging-backup'),
    branch('feature/staging-tools', 'origin/feature/staging-tools'),
    branch('staging', 'origin/staging'),
  ] })
  const status = { id: 'repo', branch: 'main', files: [], active: false, operation: null, snapshot: 'review' } as unknown as GitStatus
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><GitBranchPicker status={status} onLocate={() => {}} onChanged={async () => {}} /></I18nProvider>))
    const input = container.querySelector<HTMLInputElement>('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'staging')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const names = [...container.querySelectorAll<HTMLElement>('.git-branch-name')].map(item => item.firstChild?.textContent)
    assert.deepEqual(names, ['staging', 'staging-backup', 'feature/staging-tools', 'master'])
  } finally {
    await act(async () => root.unmount())
    gitApi.branches = original
    container.remove()
    await window.happyDOM.close()
  }
})
