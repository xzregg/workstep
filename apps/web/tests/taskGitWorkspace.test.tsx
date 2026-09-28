import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { gitApi, type GitDiscovery, type GitStatus } from '../src/api/git'
import { fsApi } from '../src/api/client'
import { useGitStore } from '../src/stores/gitStore'
import TaskGitWorkspace from '../src/components/git/TaskGitWorkspace'
import { GitApiContext } from '../src/components/git/GitApiContext'

test('task Git tab opens its directory and shows only attached worktrees', async () => {
  const { window } = installDomEnvironment()
  const originalApi = { ...gitApi }
  const originalOpen = fsApi.openDirectory
  const originalOpeners = fsApi.directoryOpeners
  const originalStore = useGitStore.getState()
  const repositories = ['A', 'B', 'C'].map(name => ({
    id: name, name, common_dir: `/project/${name}/.git`,
    projects: [{ id: 'p', relative_path: name }], worktrees: [{ id: `${name}-main`, path: `/project/${name}`, branch: 'main', head: 'sha', main: true, available: true, locked: false, prunable: false }],
  })).concat([{ id: 'root', name: 'Project', common_dir: '/project/.git', projects: [{ id: 'p', relative_path: '.' }], worktrees: [{ id: 'root-main', path: '/project', branch: 'main', head: 'sha', main: true, available: true, locked: false, prunable: false }] }])
  const data = { projects: [{ id: 'p', name: 'Project', path: '/project' }], repositories, depth: 5, scanned_at: 1, errors: [] } as GitDiscovery
  const tree = { id: 'task-b', path: '/project/.workstep/worktrees/t/B', alias: 'B', repository_id: 'B', repository_name: 'B', branch: 'workstep/t/B', head: 'sha', main: false, available: true, locked: false, prunable: false }
  let opened = 0
  const openedPaths: string[] = []
  fsApi.directoryOpeners = async () => ({ openers: [{ id: 'file_manager', label: 'file_manager', available: true }] })
  fsApi.openDirectory = async path => { openedPaths.push(path); return { path } }
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
    assert.equal(container.querySelector('.git-page-header .git-open-location .open-location-label')?.textContent, 'Open Workspace')
    assert.equal(container.querySelector('.git-context .git-open-location .open-location-label')?.textContent, 'Open Repository')
    await act(async () => container.querySelector<HTMLButtonElement>('.git-page-header .git-open-location button')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.git-context .git-open-location button')!.click())
    assert.deepEqual(openedPaths, ['/project/.workstep/worktrees/t', tree.path])
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
    assert.deepEqual([...container.querySelectorAll('option')].map(option => option.textContent), ['选择此任务需要的仓库', 'A', 'B', 'C', 'Project root'])
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
    assert.match(document.querySelector('[role="dialog"]')?.textContent || '', /unpushed|未推送/i)
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].at(-1)!
    await act(async () => confirm.click())
    assert.deepEqual(deletions, [['p', 't', true]])
    assert.match(container.querySelector('.task-git-page')?.textContent || '', /directory not empty/)
  } finally {
    await act(async () => root.unmount())
    Object.assign(gitApi, originalApi)
    fsApi.openDirectory = originalOpen
    fsApi.directoryOpeners = originalOpeners
    useGitStore.setState(originalStore)
    container.remove()
    await window.happyDOM.close()
  }
})

test('shared task Git workspace previews its directory through the scoped browser', async () => {
  const { window } = installDomEnvironment()
  const originalApi = { ...gitApi }
  const originalBrowse = fsApi.browse
  const calls: string[] = []
  const data = { projects: [{ id: 'shared', name: 'Shared task', path: '/project' }], repositories: [], depth: 0, scanned_at: 1, errors: [] } as GitDiscovery
  const tree = { id: 'shared-tree', path: '/project/.workstep/worktrees/t/repository', alias: 'repository', repository_id: 'r', repository_name: 'repository', branch: 'task', head: 'sha', main: false, available: true, locked: false, prunable: false }
  gitApi.repositories = async () => data
  gitApi.taskWorkspace = async () => ({ path: '/project/.workstep/worktrees/t', worktrees: [tree] })
  gitApi.status = async () => { throw new Error('Status unavailable in this test') }
  fsApi.browse = async () => { throw new Error('Unscoped browser must not be used') }
  const browseWorkspace = async (path: string) => {
    calls.push(path)
    return { path, name: 't', relative_path: '.workstep/worktrees/t', parent: null, parent_relative_path: null, entries: [] }
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><GitApiContext.Provider value={{ api: gitApi, shared: true, readOnly: true, browseWorkspace }}><TaskGitWorkspace projectId="shared" taskId="t" /></GitApiContext.Provider></I18nProvider>))
    await act(async () => container.querySelector<HTMLButtonElement>('.git-page-header .git-open-location button')!.click())
    assert.ok(document.querySelector('.project-directory-dialog'))
    await act(async () => document.querySelector<HTMLButtonElement>('.project-directory-dialog-header button[aria-label]')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.git-context .git-open-location button')!.click())
    assert.deepEqual(calls, ['/project/.workstep/worktrees/t', tree.path])
  } finally {
    await act(async () => root.unmount())
    Object.assign(gitApi, originalApi)
    fsApi.browse = originalBrowse
    container.remove()
    await window.happyDOM.close()
  }
})

test('task Git directory button follows the selected repository', async () => {
  const { window } = installDomEnvironment()
  const originalApi = { ...gitApi }
  const originalOpen = fsApi.openDirectory
  const originalOpeners = fsApi.directoryOpeners
  const gitState = useGitStore.getState()
  const openedPaths: string[] = []
  const worktrees = ['A', 'B'].map(alias => ({ id: alias, path: `/project/.workstep/worktrees/t/${alias}`, alias, repository_id: alias, repository_name: alias, branch: alias, head: 'sha', main: false, available: true, locked: false, prunable: false }))
  gitApi.openTaskWorkspace = async () => ({ path: '/project/.workstep/worktrees/t', worktrees })
  gitApi.status = async () => { throw new Error('Status unavailable in this test') }
  gitApi.branches = async () => ({ branches: [], remote_branches: [] })
  fsApi.directoryOpeners = async () => ({ openers: [{ id: 'file_manager', label: 'file_manager', available: true }] })
  fsApi.openDirectory = async path => { openedPaths.push(path); return { path } }
  useGitStore.setState({ data: { projects: [{ id: 'p', name: 'Project', path: '/project' }], repositories: [], depth: 5, scanned_at: 1, errors: [] }, scan: async () => {} })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><TaskGitWorkspace projectId="p" taskId="t" /></I18nProvider>))
    await act(async () => container.querySelectorAll<HTMLButtonElement>('.task-git-tree-row > button:first-child')[1].click())
    await act(async () => container.querySelector<HTMLButtonElement>('.git-context .git-open-location button')!.click())
    assert.deepEqual(openedPaths, [worktrees[1].path])
  } finally {
    await act(async () => root.unmount())
    Object.assign(gitApi, originalApi)
    fsApi.openDirectory = originalOpen
    fsApi.directoryOpeners = originalOpeners
    useGitStore.setState(gitState)
    container.remove()
    await window.happyDOM.close()
  }
})

test('same repository remains addable with a new directory and branch', async () => {
  const { window } = installDomEnvironment()
  const originalApi = { ...gitApi }
  const gitState = useGitStore.getState()
  const existing = { id: 'old', path: '/project/.workstep/worktrees/t/B-t', alias: 'B-t', repository_id: 'B', repository_name: 'B', branch: 'B-t', head: 'sha', main: false, available: true, locked: false, prunable: false }
  const created = { ...existing, id: 'new', path: '/project/.workstep/worktrees/t/B-t-2', alias: 'B-t-2', branch: 'B-t-2' }
  const data = { projects: [{ id: 'p', name: 'Project', path: '/project' }], repositories: [{ id: 'B', name: 'B', common_dir: '/project/B/.git', projects: [{ id: 'p', relative_path: 'B' }], worktrees: [{ id: 'B-main', path: '/project/B', branch: 'main', head: 'sha', main: true, available: true, locked: false, prunable: false }] }], depth: 5, scanned_at: 1, errors: [] } as GitDiscovery
  let args: unknown[] = []
  gitApi.openTaskWorkspace = async () => ({ path: '/project/.workstep/worktrees/t', worktrees: [existing] })
  gitApi.status = async () => { throw new Error('Status unavailable in this test') }
  gitApi.branches = async () => ({ branches: [{ name: 'main', head: 'sha', worktree_id: null, path: null }], remote_branches: [] })
  gitApi.addTaskWorktree = async (...values) => { args = values; return { path: '/project/.workstep/worktrees/t', worktrees: [existing, created] } }
  useGitStore.setState({ data, scan: async () => {} })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><TaskGitWorkspace projectId="p" taskId="t" /></I18nProvider>))
    const add = [...container.querySelectorAll<HTMLButtonElement>('.git-page-header button')].find(button => button.textContent === '添加仓库')!
    assert.ok(add)
    await act(async () => add.click())
    const select = container.querySelector<HTMLSelectElement>('.task-git-add select')!
    assert.ok([...select.options].some(option => option.value === 'B'))
    await act(async () => { select.value = 'B'; select.dispatchEvent(new window.Event('change', { bubbles: true })) })
    assert.equal(container.querySelector<HTMLInputElement>('.task-git-directory')?.value, 'B-t-2')
    assert.equal(container.querySelector<HTMLInputElement>('.task-git-new-branch')?.value, 'B-t-2')
    await act(async () => container.querySelector<HTMLButtonElement>('.task-git-add button')!.click())
    assert.deepEqual(args, ['p', 't', 'B', 'B-t-2', 'main', 'B-t-2'])
    assert.match(container.querySelector('.task-git-tree-row button.selected')?.textContent || '', /B-t-2/)
  } finally {
    await act(async () => root.unmount())
    Object.assign(gitApi, originalApi)
    useGitStore.setState(gitState)
    container.remove()
    await window.happyDOM.close()
  }
})

test('removing a task worktree confirms its feature branch and forces dirty cleanup', async () => {
  const { window } = installDomEnvironment()
  const originalApi = { ...gitApi }
  const originalStore = useGitStore.getState()
  const tree = { id: 'task-tree', path: '/project/.workstep/worktrees/t/source', alias: 'source', repository_id: 'repo', repository_name: 'source', branch: 'unrelated', created_branch: 'task/owned', head: 'sha', main: false, available: true, locked: false, prunable: false }
  let removedArgs: unknown[] = []
  gitApi.openTaskWorkspace = async () => ({ path: '/project/.workstep/worktrees/t', worktrees: [tree] })
  gitApi.removeTaskWorktree = async (...args) => { removedArgs = args; return { path: '/project/.workstep/worktrees/t', worktrees: [] } }
  gitApi.status = async () => { throw new Error('Status unavailable in this test') }
  useGitStore.setState({ data: { projects: [{ id: 'p', name: 'Project', path: '/project' }], repositories: [], depth: 5, scanned_at: 1, errors: [] }, scan: async () => {} })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><TaskGitWorkspace projectId="p" taskId="t" /></I18nProvider>))
    await act(async () => container.querySelector<HTMLButtonElement>('.task-git-remove')!.click())
    assert.match(document.querySelector('[role="dialog"]')?.textContent || '', /task\/owned/)
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].at(-1)!.click())
    assert.deepEqual(removedArgs, ['p', 't', 'source', true])
  } finally {
    await act(async () => root.unmount())
    Object.assign(gitApi, originalApi)
    useGitStore.setState(originalStore)
    container.remove()
    await window.happyDOM.close()
  }
})

test('task repository choices stay inside their project even when another project has Git', async () => {
  const { window } = installDomEnvironment()
  const originalApi = { ...gitApi }
  const originalStore = useGitStore.getState()
  const data = {
    projects: [{ id: 'task', name: 'Task project', path: '/task' }, { id: 'source', name: 'Source project', path: '/source' }],
    repositories: [
      { id: 'foreign', name: 'payment', common_dir: '/source/payment/.git', projects: [{ id: 'source', relative_path: 'payment' }], worktrees: [{ id: 'source-main', path: '/source/payment', branch: 'main', head: 'sha', main: true, available: true, locked: false, prunable: false }] },
      { id: 'local', name: 'local', common_dir: '/task/local/.git', projects: [{ id: 'task', relative_path: 'local' }], worktrees: [{ id: 'local-main', path: '/task/local', branch: 'main', head: 'sha', main: true, available: true, locked: false, prunable: false }] },
    ],
    depth: 5, scanned_at: 1, errors: [],
  } as GitDiscovery
  gitApi.openTaskWorkspace = async () => ({ path: '/task/.workstep/worktrees/t', worktrees: [] })
  useGitStore.setState({ data, scan: async () => {} })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><TaskGitWorkspace projectId="task" taskId="t" /></I18nProvider>))
    const add = [...container.querySelectorAll<HTMLButtonElement>('.git-page-header button')].find(button => button.textContent === '添加仓库')
    assert.ok(add)
    await act(async () => add.click())
    const select = container.querySelector<HTMLSelectElement>('.task-git-add select')!
    assert.deepEqual([...select.options].map(option => [option.value, option.textContent]), [
      ['', '选择此任务需要的仓库'], ['local', 'local'],
    ])
    assert.ok(container.querySelector('.task-git-initialize'))
  } finally {
    await act(async () => root.unmount())
    Object.assign(gitApi, originalApi)
    useGitStore.setState(originalStore)
    container.remove()
    await window.happyDOM.close()
  }
})

test('project with no Git repository offers root initialization only after confirmation', async () => {
  const { window } = installDomEnvironment()
  const originalApi = { ...gitApi }
  const originalStore = useGitStore.getState()
  const initialized: string[] = []
  let scans = 0
  gitApi.openTaskWorkspace = async () => ({ path: '/task/.workstep/worktrees/t', worktrees: [] })
  gitApi.initialize = async projectId => { initialized.push(projectId); return { project_id: projectId, path: '/task' } }
  const data = { projects: [{ id: 'task', name: 'Task', path: '/task' }], repositories: [], depth: 5, scanned_at: 1, errors: [] } as GitDiscovery
  useGitStore.setState({ data, scan: async () => {
    scans++
    if (initialized.length) useGitStore.setState({ data: { ...data, repositories: [{ id: 'root', name: 'Task', common_dir: '/task/.git', projects: [{ id: 'task', relative_path: '.' }], worktrees: [{ id: 'root-main', path: '/task', branch: 'main', head: 'sha', main: true, available: true, locked: false, prunable: false }] }] } })
  } })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><TaskGitWorkspace projectId="task" taskId="t" /></I18nProvider>))
    const add = [...container.querySelectorAll<HTMLButtonElement>('.git-page-header button')].find(button => button.textContent === '添加仓库')
    assert.equal(add, undefined)
    assert.match(container.querySelector('.task-git-initialize')?.textContent || '', /project root|项目根目录/)
    const initialize = container.querySelector<HTMLButtonElement>('.task-git-initialize button')!
    await act(async () => initialize.click())
    assert.match(document.querySelector('[role="dialog"]')?.textContent || '', /项目根目录/)
    assert.deepEqual(initialized, [])
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click())
    assert.deepEqual(initialized, [])
    await act(async () => initialize.click())
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].at(-1)!.click())
    assert.deepEqual(initialized, ['task'])
    assert.equal(scans, 2)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.ok([...container.querySelectorAll<HTMLButtonElement>('.git-page-header button')].some(button => button.textContent === '添加仓库'))
    assert.equal(container.querySelector('.task-git-initialize'), null)
  } finally {
    await act(async () => root.unmount())
    Object.assign(gitApi, originalApi)
    useGitStore.setState(originalStore)
    container.remove()
    await window.happyDOM.close()
  }
})
