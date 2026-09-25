import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { gitApi, type GitDiscovery, type GitStatus } from '../src/api/git'
import { useGitStore } from '../src/stores/gitStore'
import TaskGitWorkspace from '../src/components/git/TaskGitWorkspace'

test('task Git tab opens its directory and shows only attached worktrees', async () => {
  const { window } = installDomEnvironment()
  const originalApi = { ...gitApi }
  const originalStore = useGitStore.getState()
  const repositories = ['A', 'B', 'C'].map(name => ({
    id: name, name, common_dir: `/project/${name}/.git`,
    projects: [{ id: 'p', relative_path: name }], worktrees: [{ id: `${name}-main`, path: `/project/${name}`, branch: 'main', head: 'sha', main: true, available: true, locked: false, prunable: false }],
  })).concat([{ id: 'root', name: 'Project', common_dir: '/project/.git', projects: [{ id: 'p', relative_path: '.' }], worktrees: [{ id: 'root-main', path: '/project', branch: 'main', head: 'sha', main: true, available: true, locked: false, prunable: false }] }])
  const data = { projects: [{ id: 'p', name: 'Project', path: '/project' }], repositories, depth: 5, scanned_at: 1, errors: [] } as GitDiscovery
  const tree = { id: 'task-b', path: '/project/.workstep/worktrees/t/B', alias: 'B', repository_id: 'B', repository_name: 'B', branch: 'workstep/t/B', head: 'sha', main: false, available: true, locked: false, prunable: false }
  let opened = 0
  const deletions: unknown[][] = []
  let createdArgs: unknown[] | null = null
  gitApi.openTaskWorkspace = async () => { opened++; return { path: '/project/.workstep/worktrees/t', worktrees: [tree] } }
  gitApi.deleteTaskWorkspace = async (...args) => { deletions.push(args); return { path: '/project/.workstep/worktrees/t', worktrees: [], outcome: 'partial', removed_aliases: ['B'], failure: 'directory not empty' } }
  gitApi.status = async () => ({ id: tree.id, path: tree.path, branch: tree.branch, head: 'sha', files: [{ path: 'changed.ts', old_path: null, index_status: ' ', worktree_status: 'M', staged: false, untracked: false, conflict: false, submodule: false }], snapshot: 'snapshot', operation: null, active: false, ahead: 2, behind: 0, upstream: 'origin/workstep/t/B' } as GitStatus)
  gitApi.remotes = async () => ({ remotes: [], upstream: null, fetched_at: null })
  gitApi.identity = async () => ({ name: 'Test User', email: 'test@example.com' })
  gitApi.credentials = async () => ({ remotes: [], hosts: [] })
  gitApi.branches = async id => ({ branches: id === 'root-main' ? ['main', 'release'].map(name => ({ name, head: 'sha', worktree_id: null, path: null })) : [], remote_branches: [] })
  gitApi.addTaskWorktree = async (...args) => { createdArgs = args; return { path: '/project/.workstep/worktrees/t', worktrees: [tree] } }
  useGitStore.setState({ data, scan: async () => {} })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><TaskGitWorkspace projectId="p" taskId="t" /></I18nProvider>))
    assert.equal(opened, 1)
    assert.equal(container.querySelector('.task-git-page h1')?.textContent, 'Git Workspace')
    assert.deepEqual([...container.querySelectorAll('.task-git-tree strong')].map(element => element.textContent), ['B'])
    assert.equal(container.querySelector('.git-context h2')?.textContent, 'workstep/t/B')
    const settings = container.querySelector<HTMLButtonElement>('.task-git-page .git-settings-toggle')!
    await act(async () => settings.click())
    assert.ok(container.querySelector<HTMLInputElement>('input[name="gitAuthHost"]'))
    await act(async () => settings.click())
    const resizer = container.querySelector<HTMLElement>('.task-git-page .git-tree-resizer')!
    assert.ok(resizer)
    assert.equal(resizer.getAttribute('aria-valuenow'), '280')
    await act(async () => resizer.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' })))
    assert.equal(resizer.getAttribute('aria-valuenow'), '296')
    resizer.setPointerCapture = () => {}
    await act(async () => resizer.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 100 })))
    await act(async () => window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 140 })))
    assert.equal(resizer.getAttribute('aria-valuenow'), '336')
    await act(async () => window.dispatchEvent(new window.PointerEvent('pointerup')))
    assert.equal(container.querySelectorAll('option').length, 0)
    const add = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '添加仓库')!
    await act(async () => add.click())
    assert.deepEqual([...container.querySelectorAll('option')].map(option => option.textContent), ['选择此任务需要的仓库', 'A', 'C', 'Project root'])
    const select = container.querySelector<HTMLSelectElement>('.task-git-add select')!
    await act(async () => { select.value = 'root'; select.dispatchEvent(new window.Event('change', { bubbles: true })) })
    const source = container.querySelector<HTMLSelectElement>('.task-git-source-branch')!
    assert.deepEqual([...source.options].map(option => option.value), ['main', 'release'])
    assert.deepEqual([...container.querySelectorAll('.task-git-add > label')].map(label => label.className), ['', 'task-git-source-label'])
    assert.deepEqual([...container.querySelectorAll('.task-git-name-fields > label')].map(label => label.className), ['task-git-branch-label', 'task-git-directory-label'])
    assert.equal(container.querySelector<HTMLInputElement>('.task-git-new-branch')?.value, 'Project-t')
    assert.equal(container.querySelector<HTMLInputElement>('.task-git-directory')?.value, 'Project-t')
    await act(async () => { source.value = 'release'; source.dispatchEvent(new window.Event('change', { bubbles: true })) })
    const branch = container.querySelector<HTMLInputElement>('.task-git-new-branch')!
    const directory = container.querySelector<HTMLInputElement>('.task-git-directory')!
    async function changeInput(input: HTMLInputElement, value: string) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
    }
    await changeInput(branch, 'feature-one')
    assert.equal(directory.value, 'Project-t')
    await changeInput(directory, 'custom-directory')
    assert.equal(branch.value, 'feature-one')
    await changeInput(branch, 'feature-one-updated')
    assert.equal(directory.value, 'custom-directory')
    await changeInput(directory, '')
    await changeInput(branch, 'feature-two')
    assert.equal(directory.value, 'feature-two')
    await changeInput(branch, 'feature-three')
    assert.equal(directory.value, 'feature-three')
    await changeInput(directory, 'manual-directory')
    await changeInput(branch, 'feature-four')
    assert.equal(directory.value, 'manual-directory')
    const create = [...container.querySelectorAll<HTMLButtonElement>('.task-git-add button')].at(-1)!
    await act(async () => create.click())
    assert.deepEqual(createdArgs, ['p', 't', 'root', 'manual-directory', 'release', 'feature-four'])
    const deleteButton = container.querySelector<HTMLButtonElement>('.task-git-delete-workspace')!
    assert.equal(deleteButton, container.querySelector('.git-page-header > button:last-child'))
    await act(async () => deleteButton.click())
    assert.equal(deletions.length, 0)
    assert.match(document.querySelector('[role="dialog"]')?.textContent || '', /uncommitted|未提交/)
    assert.match(document.querySelector('[role="dialog"]')?.textContent || '', /unpushed|未推送/)
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].at(-1)!
    await act(async () => confirm.click())
    assert.deepEqual(deletions, [['p', 't', true]])
    assert.match(container.querySelector('.task-git-page')?.textContent || '', /directory not empty/)
  } finally {
    await act(async () => root.unmount())
    Object.assign(gitApi, originalApi)
    useGitStore.setState(originalStore)
    container.remove()
    await window.happyDOM.close()
  }
})
