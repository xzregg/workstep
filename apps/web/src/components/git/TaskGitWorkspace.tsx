import { useGitApi, useGitWorkspaceBrowser, useReadOnlyGit, useSharedGit, useGitWorkspaceEditable } from './GitApiContext'
import { useEffect, useMemo, useState } from 'react'
import { type GitDiscovery, type TaskGitWorkspace as Workspace } from '../../api/git'
import { useGitStore } from '../../stores/gitStore'
import { useProjectStore } from '../../stores/projectStore'
import { useI18n } from '../../i18n'
import Button from '../Button'
import ConfirmDialog from '../ConfirmDialog'
import Icon from '../Icon'
import OpenLocationButton from '../OpenLocationButton'
import GitWorktreePanel from './GitWorktreePanel'
import GitRepositorySettings from './GitRepositorySettings'
import { clampGitTreeWidth, useGitTreeResize } from './useGitTreeResize'
import './git.css'

export default function TaskGitWorkspace({ projectId, taskId }: { projectId: string; taskId: string }) {
  const gitApi = useGitApi()
  const shared = useSharedGit()
  const readOnly = useReadOnlyGit()
  const workspaceEditable = useGitWorkspaceEditable()
  const browseWorkspace = useGitWorkspaceBrowser()
  const { t } = useI18n()
  const { data, scan } = useGitStore()
  const projects = useProjectStore(state => state.projects)
  const [sharedData, setSharedData] = useState<GitDiscovery | null>(null)
  const refreshRepositories = async () => {
    if (shared) setSharedData(await gitApi.repositories())
    else await scan()
  }
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [selected, setSelected] = useState('')
  const [repositoryId, setRepositoryId] = useState('')
  const [alias, setAlias] = useState('')
  const [syncEmptyDirectory, setSyncEmptyDirectory] = useState(false)
  const [baseRef, setBaseRef] = useState('')
  const [branchName, setBranchName] = useState('')
  const [sourceBranches, setSourceBranches] = useState<string[]>([])
  const [branchLoading, setBranchLoading] = useState(false)
  const [branchError, setBranchError] = useState('')
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [initializeOpen, setInitializeOpen] = useState(false)
  const [initializing, setInitializing] = useState(false)
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState('')
  const [removeBusy, setRemoveBusy] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [settings, setSettings] = useState(false)
  const [deleteWorkspaceOpen, setDeleteWorkspaceOpen] = useState(false)
  const [deleteWorkspaceBusy, setDeleteWorkspaceBusy] = useState(false)
  const [deleteWorkspaceChecking, setDeleteWorkspaceChecking] = useState(false)
  const [deleteWorkspaceDirty, setDeleteWorkspaceDirty] = useState<string[]>([])
  const [deleteWorkspaceBranches, setDeleteWorkspaceBranches] = useState<string[]>([])
  const { treeWidth, startResize, resizeWithKeyboard, resetResize } = useGitTreeResize()

  const discovery = shared ? sharedData : data
  const repositories = useMemo(() => discovery?.repositories.filter(repo =>
    repo.projects.some(project => project.id === projectId),
  ) ?? [], [discovery, projectId])
  const hasRootRepository = repositories.some(repo => repo.projects.some(project => project.id === projectId && project.relative_path === '.'))
  const sourceTree = repositories.find(repo => repo.id === repositoryId)?.worktrees.find(tree => tree.main && tree.available)
    ?? repositories.find(repo => repo.id === repositoryId)?.worktrees.find(tree => tree.available)
  const sourceTreeId = sourceTree?.id
  const currentSourceBranch = sourceTree?.branch

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    void refreshRepositories().then(() => (readOnly || !workspaceEditable) ? gitApi.taskWorkspace(projectId, taskId) : gitApi.openTaskWorkspace(projectId, taskId)).then(result => {
      if (active) setWorkspace(result)
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [projectId, taskId, scan, shared, readOnly, workspaceEditable, gitApi])

  useEffect(() => {
    if (!sourceTreeId) {
      setSourceBranches([])
      setBaseRef('')
      setBranchLoading(false)
      setBranchError('')
      return
    }
    let active = true
    setBranchLoading(true)
    setBranchError('')
    setSourceBranches([])
    setBaseRef('')
    void gitApi.branches(sourceTreeId).then(result => {
      if (!active) return
      const names = result.branches.map(branch => branch.name)
      setSourceBranches(names)
      setBaseRef(currentSourceBranch && names.includes(currentSourceBranch) ? currentSourceBranch : names[0] || '')
    }).catch(reason => {
      if (active) setBranchError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (active) setBranchLoading(false) })
    return () => { active = false }
  }, [sourceTreeId, currentSourceBranch])

  const selectedTree = workspace?.worktrees.find(tree => tree.id === selected) ?? workspace?.worktrees[0]
  const settingsId = selectedTree?.id ?? repositories.flatMap(repo => repo.worktrees).find(tree => tree.available)?.id
  const discoveredProject = (shared ? sharedData : data)?.projects.find(item => item.id === projectId)
  const project = projects.find(item => item.id === projectId)
    ?? (discoveredProject ? { ...discoveredProject, steps: [], workflows: [] } : null)

  async function refresh() {
    await refreshRepositories()
    const result = await gitApi.taskWorkspace(projectId, taskId)
    setWorkspace(result)
  }

  async function initializeProjectRoot() {
    if (initializing) return
    setInitializing(true)
    setError('')
    try {
      await gitApi.initialize(projectId)
      setInitializeOpen(false)
      await scan(`initialize:${projectId}:${Date.now()}`)
      const scanError = useGitStore.getState().error
      if (scanError) setError(scanError)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setInitializing(false) }
  }

  async function add() {
    if (!repositoryId || adding) return
    const repo = repositories.find(item => item.id === repositoryId)
    if (!repo) return
    setAdding(true)
    setError('')
    try {
      const result = await gitApi.addTaskWorktree(projectId, taskId, repositoryId, alias, baseRef, branchName)
      setWorkspace(result)
      setSelected(result.worktrees.find(tree => tree.alias === alias)?.id || '')
      setRepositoryId('')
      setAlias('')
      setSyncEmptyDirectory(false)
      setBaseRef('')
      setBranchName('')
      setShowAdd(false)
      await refreshRepositories()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setAdding(false) }
  }

  async function remove() {
    if (!removing || removeBusy) return
    setRemoveBusy(true)
    setError('')
    try {
      const result = await gitApi.removeTaskWorktree(projectId, taskId, removing, true)
      setWorkspace(result)
      setSelected(result.worktrees[0]?.id || '')
      setRemoving('')
      await refreshRepositories()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      try { await refresh() } catch { /* Keep the original deletion error visible. */ }
    } finally { setRemoveBusy(false) }
  }

  async function deleteWorkspace() {
    if (deleteWorkspaceBusy) return
    setDeleteWorkspaceBusy(true)
    setError('')
    try {
      const result = await gitApi.deleteTaskWorkspace(projectId, taskId, deleteWorkspaceDirty.length > 0)
      setWorkspace(result)
      setSelected(result.worktrees[0]?.id || '')
      setShowAdd(false)
      setDeleteWorkspaceOpen(false)
      const partial = result.outcome === 'partial' ? t('git.taskDeleteWorkspacePartial', { names: result.removed_aliases.join('、'), reason: result.failure }) : ''
      try { await refreshRepositories() }
      catch (reason) { setError([partial, reason instanceof Error ? reason.message : String(reason)].filter(Boolean).join(' ')); return }
      if (partial) setError(partial)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setDeleteWorkspaceOpen(false)
    } finally { setDeleteWorkspaceBusy(false) }
  }

  async function inspectWorkspaceBeforeDelete() {
    if (deleteWorkspaceChecking || !workspace) return
    setDeleteWorkspaceChecking(true)
    setError('')
    try {
      const statuses = await Promise.all(workspace.worktrees.map(tree => gitApi.status(tree.id)))
      setDeleteWorkspaceDirty(statuses.flatMap((status, index) => status.files.length ? [workspace.worktrees[index].alias] : []))
      setDeleteWorkspaceBranches(workspace.worktrees.map(tree => tree.created_branch || tree.branch).filter((branch): branch is string => Boolean(branch)))
      setDeleteWorkspaceOpen(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setDeleteWorkspaceChecking(false) }
  }

  return <section className="git-page task-git-page" aria-label={t('git.taskWorkspace')}>
    <header className="git-page-header">
      <h1>{t('git.taskWorkspace')}</h1>
      <small title={workspace?.relative_path || workspace?.path}>{workspace?.relative_path || workspace?.path}</small>
      <span className="git-grow" />
      {workspace?.path && project && <span className="git-open-location"><OpenLocationButton activeProject={project} directoryPath={workspace.path} buttonLabel={t('git.taskOpenWorkspaceDirectory')} browserProjectId={shared ? '' : projectId} forceWebBrowser={shared} browseDirectory={shared ? browseWorkspace : undefined} readOnlyBrowser={shared} t={t} /></span>}
      {!readOnly && workspaceEditable && repositories.length > 0 && <Button size="sm" onClick={() => setShowAdd(value => !value)}>{t('git.taskAddRepository')}</Button>}
      {!readOnly && workspaceEditable && settingsId && <Button className="git-settings-toggle" size="sm" aria-label={t('git.settings')} aria-expanded={settings} onClick={() => setSettings(value => !value)}><Icon name="settings" size={14} /><span>{t('git.settings')}</span></Button>}
      <Button size="sm" loading={loading} onClick={() => void refresh()}>{t('git.refresh')}</Button>
      {!readOnly && workspaceEditable && <Button className="task-git-delete-workspace" size="sm" variant="danger" loading={deleteWorkspaceChecking} disabled={loading} onClick={() => void inspectWorkspaceBeforeDelete()}>{t('git.taskDeleteWorkspace')}</Button>}
    </header>
    {error && <div className="git-error" role="alert">{error}</div>}
    {!loading && !shared && !readOnly && workspaceEditable && discovery && !hasRootRepository && <div className="task-git-initialize">
      <span>{t('git.taskRootNotGit')}</span>
      <Button size="sm" variant="primary" loading={initializing} onClick={() => setInitializeOpen(true)}>{t('git.initialize')}</Button>
    </div>}
    {loading ? <div className="git-empty"><Icon name="loader-circle" className="git-spin" size={24} />{t('git.loading')}</div> : <>
      {!readOnly && workspaceEditable && showAdd && repositories.length > 0 && <div className="task-git-add">
        <label>{t('git.taskAddRepository')}
          <select value={repositoryId} onChange={event => {
            const id = event.target.value
            const repo = repositories.find(item => item.id === id)
            const suffix = (taskId.replace(/[^A-Za-z0-9]/g, '') || 'task').slice(0, 8)
            const stem = repo?.name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[._-]+|[._-]+$/g, '')
              || `repo-${repo?.id.slice(0, 6) || 'git'}`
            const baseAlias = repo ? `${stem.slice(0, 63 - suffix.length)}-${suffix}` : ''
            const takenAliases = new Set(workspace?.worktrees.map(tree => tree.alias))
            const takenBranches = new Set(workspace?.worktrees.filter(tree => tree.repository_id === id).map(tree => tree.branch))
            let nextAlias = baseAlias
            for (let number = 2; nextAlias && (takenAliases.has(nextAlias) || takenBranches.has(nextAlias)); number++) {
              const postfix = `-${number}`
              nextAlias = `${baseAlias.slice(0, 64 - postfix.length)}${postfix}`
            }
            setRepositoryId(id)
            setAlias(nextAlias)
            setSyncEmptyDirectory(false)
            setBranchName(nextAlias)
          }}>
            <option value="">{t('git.taskSelectRepository')}</option>
            {repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.projects.find(item => item.id === projectId)?.relative_path === '.' ? t('git.taskProjectRoot') : repo.projects.find(item => item.id === projectId)?.relative_path || repo.name}</option>)}
          </select>
        </label>
        {repositoryId && <>
          <label className="task-git-source-label">{t('git.taskBaseRef')}<select className="task-git-source-branch" value={baseRef} disabled={branchLoading || !sourceBranches.length} onChange={event => setBaseRef(event.target.value)}>
            {!sourceBranches.length && <option value="">{branchLoading ? t('git.loading') : t('git.taskNoBranches')}</option>}
            {sourceBranches.map(name => <option key={name} value={name}>{name}</option>)}
          </select></label>
          <div className="task-git-name-fields">
            <label className="task-git-branch-label">{t('git.taskNewBranch')}<input className="task-git-new-branch" value={branchName} onChange={event => {
              const nextBranch = event.target.value
              if (syncEmptyDirectory || !alias) {
                setAlias(nextBranch)
                setSyncEmptyDirectory(true)
              }
              setBranchName(nextBranch)
            }} /></label>
            <label className="task-git-directory-label">{t('git.taskDirectory')}<input className="task-git-directory" value={alias} onChange={event => {
              const nextAlias = event.target.value
              setAlias(nextAlias)
              setSyncEmptyDirectory(!nextAlias)
            }} /></label>
          </div>
          {branchLoading && <Icon name="loader-circle" className="git-spin" size={14} />}
          {branchError && <small className="git-danger" role="alert">{branchError}</small>}
          <Button variant="primary" loading={adding} disabled={!alias || !baseRef || !branchName || branchLoading} onClick={() => void add()}>{t('git.taskCreateWorktree')}</Button>
        </>}
      </div>}
      {!readOnly && workspaceEditable && settings && settingsId ? <main className="git-settings"><GitRepositorySettings key={settingsId} id={settingsId} /></main> : workspace?.worktrees.length ? <div className="git-page-body">
        <aside className="task-git-tree" style={{ width: treeWidth, flexBasis: treeWidth }}>
          {workspace.worktrees.map(tree => <div className="task-git-tree-row" key={tree.id}>
            <button type="button" className={tree.id === selectedTree?.id ? 'selected' : ''} onClick={() => setSelected(tree.id)} title={tree.relative_path || tree.path}>
              <Icon name="git-fork" size={16} /><span><strong>{tree.alias}</strong><small>{tree.branch}</small></span>
            </button>
            {!readOnly && workspaceEditable && <button type="button" className="task-git-remove" title={t('git.taskRemove')} aria-label={`${t('git.taskRemove')} ${tree.alias}`} onClick={() => setRemoving(tree.alias)}><Icon name="trash" size={14} /></button>}
          </div>)}
        </aside>
        <div className="git-tree-resizer" role="separator" aria-orientation="vertical" aria-label={t('git.resizeTree')} aria-valuemin={230} aria-valuemax={clampGitTreeWidth(Number.MAX_SAFE_INTEGER)} aria-valuenow={treeWidth} tabIndex={0} onPointerDown={startResize} onDoubleClick={resetResize} onKeyDown={resizeWithKeyboard} />
        {selectedTree && <GitWorktreePanel key={selectedTree.id} id={selectedTree.id} displayPath={selectedTree.relative_path} headerActions={project && <span className="git-open-location"><OpenLocationButton activeProject={project} directoryPath={selectedTree.path} buttonLabel={t('git.taskOpenRepositoryDirectory')} browserProjectId={shared ? '' : projectId} forceWebBrowser={shared} browseDirectory={shared ? browseWorkspace : undefined} readOnlyBrowser={shared} t={t} /></span>} onLocate={id => {
          if (workspace.worktrees.some(tree => tree.id === id)) setSelected(id)
        }} onChanged={refresh} />}
      </div> : <div className="git-empty"><Icon name="git-fork" size={28} /><h2>{t('git.taskEmpty')}</h2><p>{t('git.taskEmptyHint')}</p></div>}
    </>}
    <ConfirmDialog open={initializeOpen} title={t('git.initialize')} message={t('git.initializeHint')} confirmText={t('git.initialize')} loading={initializing} onConfirm={() => void initializeProjectRoot()} onCancel={() => { if (!initializing) setInitializeOpen(false) }} />
    <ConfirmDialog open={!!removing} title={t('git.taskRemove')} message={t('git.taskRemoveHint', { name: removing, branch: workspace?.worktrees.find(tree => tree.alias === removing)?.created_branch || workspace?.worktrees.find(tree => tree.alias === removing)?.branch || '—' })} confirmText={t('git.taskRemove')} danger loading={removeBusy} onConfirm={() => void remove()} onCancel={() => { if (!removeBusy) setRemoving('') }} />
    <ConfirmDialog open={deleteWorkspaceOpen} title={t('git.taskDeleteWorkspace')} message={[t('git.taskDeleteWorkspaceHint', { count: workspace?.worktrees.length ?? 0 }), deleteWorkspaceDirty.length ? t('git.taskDeleteWorkspaceDirty', { names: deleteWorkspaceDirty.join('、') }) : '', deleteWorkspaceBranches.length ? t('git.taskDeleteWorkspaceUnpushed', { names: deleteWorkspaceBranches.join('、') }) : ''].filter(Boolean).join(' ')} confirmText={t('git.taskDeleteWorkspace')} danger loading={deleteWorkspaceBusy} onConfirm={() => void deleteWorkspace()} onCancel={() => { if (!deleteWorkspaceBusy) setDeleteWorkspaceOpen(false) }} />
  </section>
}
