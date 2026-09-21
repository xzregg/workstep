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
  let pulled: unknown[] = []
  gitApi.branches = async () => ({ branches: [main, feature] })
  gitApi.fetch = async () => { fetched++; return { branches: [{ ...main, behind: 1 }, feature], fetched_at: 1700000000 } }
  gitApi.pull = async (...args) => { pulled = args; return state }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const click = async (label: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label)!.click())
  try {
    await act(async () => root.render(<I18nProvider><GitBranchPicker status={state} onLocate={() => {}} onChanged={async () => { changed++ }} /></I18nProvider>))
    assert.equal(container.querySelector('.git-branch-list')?.getAttribute('role'), 'listbox')
    assert.equal(container.querySelectorAll('.git-branch-row[role="option"]').length, 2)
    assert.equal(fetched, 0)
    assert.match(container.textContent!, /已同步/)
    assert.match(container.textContent!, /落后 2/)
    const input = container.querySelector<HTMLInputElement>('input')!
    const search = async (value: string) => act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await search('ft pay rpt')
    assert.equal(container.querySelectorAll('.git-branch-row').length, 1)
    assert.match(container.querySelector('.git-branch-row')!.textContent!, /feature\/payment-report/)
    await search('zzzzzz')
    assert.match(container.textContent!, /没有匹配/)
    await search('')
    await click('刷新远程状态')
    assert.equal(fetched, 1)
    assert.match(container.textContent!, /落后 1/)
    await click('拉取最新')
    assert.deepEqual(pulled, ['repo', 'main', 'review'])
    assert.equal(changed, 1)
    await act(async () => root.render(<I18nProvider><GitBranchPicker status={{ ...state, active: true }} onLocate={() => {}} onChanged={async () => {}} /></I18nProvider>))
    assert.equal([...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '拉取最新')!.disabled, true)
  } finally { await act(async () => root.unmount()); Object.assign(gitApi, original); container.remove(); await window.happyDOM.close() }
})
