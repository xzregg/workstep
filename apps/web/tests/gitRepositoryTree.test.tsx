import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { gitApi, type GitDiscovery } from '../src/api/git'
import GitRepositoryTree from '../src/components/git/GitRepositoryTree'

test('repository tree collapses and expands every repository with one action', async () => {
  const { window } = installDomEnvironment()
  const original = gitApi.branches
  gitApi.branches = async id => ({ branches: [
    { name: 'main', head: 'sha', worktree_id: id, path: `/project/${id.replace('-tree', '')}` },
    { name: 'other-only', head: 'other', worktree_id: null, path: null },
  ], fetched_at: null })
  const data = {
    projects: [{ id: 'project', name: '项目', path: '/project' }],
    repositories: ['api', 'web'].map(name => ({
      id: name, name, common_dir: `/project/${name}/.git`, projects: [{ id: 'project', relative_path: name }],
      worktrees: [{ id: `${name}-tree`, path: `/project/${name}`, branch: 'main', head: 'sha', main: true, available: true, locked: false, prunable: false }],
    })),
    depth: 5, scanned_at: 1, errors: [],
  } as GitDiscovery
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><GitRepositoryTree data={data} onSelect={() => {}} /></I18nProvider>))
    assert.doesNotMatch(container.textContent!, /其他分支|other-only|浏览分支/)
    const titles = () => [...container.querySelectorAll<HTMLButtonElement>('.git-repository-title')]
    assert.deepEqual(titles().map(button => button.getAttribute('aria-expanded')), ['true', 'true'])
    const toggle = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '全部折叠')!
    await act(async () => toggle().click())
    assert.deepEqual(titles().map(button => button.getAttribute('aria-expanded')), ['false', 'false'])
    assert.equal(container.querySelectorAll('.git-tree-item').length, 0)
    const expand = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '全部展开')!
    await act(async () => expand.click())
    assert.deepEqual(titles().map(button => button.getAttribute('aria-expanded')), ['true', 'true'])
    assert.equal(container.querySelectorAll('.git-tree-item').length, 2)
  } finally {
    await act(async () => root.unmount())
    gitApi.branches = original
    container.remove()
    await window.happyDOM.close()
  }
})

test('selecting a repository name does not collapse it', async () => {
  const { window } = installDomEnvironment()
  const originalBranches = gitApi.branches
  const originalSelection = window.getSelection
  gitApi.branches = async () => ({ branches: [], fetched_at: null })
  const data = {
    projects: [{ id: 'project', name: '项目', path: '/project' }],
    repositories: [{ id: 'web', name: 'web', common_dir: '/project/web/.git', projects: [{ id: 'project', relative_path: 'web' }], worktrees: [] }],
    depth: 5, scanned_at: 1, errors: [],
  } as GitDiscovery
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><GitRepositoryTree data={data} onSelect={() => {}} /></I18nProvider>))
    window.getSelection = () => ({ toString: () => 'web' }) as Selection
    await act(async () => container.querySelector<HTMLButtonElement>('.git-repository-title')!.click())
    assert.equal(container.querySelector('.git-repository-title')!.getAttribute('aria-expanded'), 'true')
  } finally {
    window.getSelection = originalSelection
    await act(async () => root.unmount())
    gitApi.branches = originalBranches
    container.remove()
    await window.happyDOM.close()
  }
})
