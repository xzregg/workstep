import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { gitApi } from '../src/api/git'
import GitWorktreeDeleteButton from '../src/components/git/GitWorktreeDeleteButton'
import { useGitStore } from '../src/stores/gitStore'

test('worktree delete button confirms, recovers from errors and refreshes after success', async () => {
  const { window } = installDomEnvironment()
  const originals = { branches: gitApi.branches, status: gitApi.status, deleteWorktree: gitApi.deleteWorktree, scan: useGitStore.getState().scan }
  gitApi.branches = async () => ({ branches: [{ name: 'local-only', head: 'sha', worktree_id: null, path: null }] })
  const trees = ['main', 'master', 'feature', null].map((branch, i) => ({ id: `tree-${i}`, path: `/repo/${i}`, branch, head: 'sha', main: i === 0, available: true, locked: false, prunable: false }))
  let deletes = 0
  gitApi.status = async () => ({ snapshot: 'reviewed' } as Awaited<ReturnType<typeof gitApi.status>>)
  gitApi.deleteWorktree = async (id, snapshot) => { assert.equal(id, 'tree-2'); assert.equal(snapshot, 'reviewed'); deletes++; throw new Error('未提交内容') }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const selections: string[] = []
  let scans = 0
  useGitStore.setState({ scan: async () => { scans++ } })
  try {
    await act(async () => root.render(<I18nProvider><GitWorktreeDeleteButton tree={trees[2]} onDeleted={() => selections.push('deleted')} /></I18nProvider>))
    await act(async () => container.querySelector<HTMLButtonElement>('.git-tree-delete')!.click())
    assert.equal(deletes, 0)
    const dialog = document.querySelector('[role="dialog"]')!
    assert.match(dialog.textContent!, /feature/)
    await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(b => b.classList.contains('btn-danger'))!.click())
    assert.equal(deletes, 1)
    assert.match(dialog.textContent!, /未提交内容/)
    gitApi.deleteWorktree = async id => ({ deleted: id })
    await act(async () => dialog.querySelector<HTMLButtonElement>('.btn-danger')!.click())
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.deepEqual(selections, ['deleted'])
    assert.equal(scans, 1)
  } finally {
    await act(async () => root.unmount())
    const { scan, ...apiOriginals } = originals
    Object.assign(gitApi, apiOriginals)
    useGitStore.setState({ scan })
    container.remove()
    await window.happyDOM.close()
  }
})


test('missing worktree cleanup uses its recorded head without querying the missing directory', async () => {
  const { window } = installDomEnvironment()
  const originalStatus = gitApi.status
  const originalDelete = gitApi.deleteWorktree
  const originalScan = useGitStore.getState().scan
  const tree = { id: 'missing', path: '/missing', branch: null, head: 'recorded-head', main: false, available: false, locked: false, prunable: true }
  let deleted = false
  gitApi.status = async () => { throw new Error('missing directory must not be queried') }
  gitApi.deleteWorktree = async (id, snapshot, head) => {
    assert.equal(id, tree.id)
    assert.equal(snapshot, undefined)
    assert.equal(head, tree.head)
    deleted = true
    return { deleted: id }
  }
  useGitStore.setState({ scan: async () => {} })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><GitWorktreeDeleteButton tree={tree} onDeleted={() => {}} /></I18nProvider>))
    await act(async () => container.querySelector<HTMLButtonElement>('.git-tree-delete')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] .btn-danger')!.click())
    assert.equal(deleted, true)
    assert.equal(document.querySelector('[role="dialog"]'), null)
  } finally {
    await act(async () => root.unmount())
    gitApi.status = originalStatus
    gitApi.deleteWorktree = originalDelete
    useGitStore.setState({ scan: originalScan })
    container.remove()
    await window.happyDOM.close()
  }
})
