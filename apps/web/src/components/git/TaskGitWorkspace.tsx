import { useEffect, useMemo, useState } from 'react'
import { gitApi, type TaskGitWorkspace as Workspace } from '../../api/git'
import { useGitStore } from '../../stores/gitStore'
import { useI18n } from '../../i18n'
import Button from '../Button'
import ConfirmDialog from '../ConfirmDialog'
import Icon from '../Icon'
import GitWorktreePanel from './GitWorktreePanel'
import { clampGitTreeWidth, useGitTreeResize } from './useGitTreeResize'
import './git.css'

export default function TaskGitWorkspace({ projectId, taskId }: { projectId: string; taskId: string }) {
  const { t } = useI18n()
  const { data, scan } = useGitStore()
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
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState('')
  const [removeBusy, setRemoveBusy] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [deleteWorkspaceOpen, setDeleteWorkspaceOpen] = useState(false)
  const [deleteWorkspaceBusy, setDeleteWorkspaceBusy] = useState(false)
  const { treeWidth, startResize, resizeWithKeyboard, resetResize } = useGitTreeResize()

  const repositories = useMemo(() => data?.repositories.filter(repo =>
    repo.projects.some(project => project.id === projectId),
  ) ?? [], [data, projectId])
  const available = repositories.filter(repo => !workspace?.worktrees.some(tree => tree.repository_id === repo.id))
  const sourceTree = repositories.find(repo => repo.id === repositoryId)?.worktrees.find(tree => tree.main && tree.available)
    ?? repositories.find(repo => repo.id === repositoryId)?.worktrees.find(tree => tree.available)
  const sourceTreeId = sourceTree?.id
  const currentSourceBranch = sourceTree?.branch

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    void scan().then(() => gitApi.openTaskWorkspace(projectId, taskId)).then(result => {
      if (active) setWorkspace(result)
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [projectId, taskId, scan])

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

  async function refresh() {
    await scan()
    const result = await gitApi.taskWorkspace(projectId, taskId)
    setWorkspace(result)
  }

  async function add() {
    if (!repositoryId || adding) return
    const repo = available.find(item => item.id === repositoryId)
    if (!repo) return
    setAdding(true)
    setError('')
    try {
      const result = await gitApi.addTaskWorktree(projectId, taskId, repositoryId, alias, baseRef, branchName)
      setWorkspace(result)
      setSelected(result.worktrees.find(tree => tree.repository_id === repositoryId)?.id || '')
      setRepositoryId('')
      setAlias('')
      setSyncEmptyDirectory(false)
      setBaseRef('')
      setBranchName('')
      setShowAdd(false)
      await scan()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setAdding(false) }
  }

  async function remove() {
    if (!removing || removeBusy) return
    setRemoveBusy(true)
    setError('')
    try {
      const result = await gitApi.removeTaskWorktree(projectId, taskId, removing)
      setWorkspace(result)
      setSelected(result.worktrees[0]?.id || '')
      setRemoving('')
      await scan()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setRemoveBusy(false) }
  }

  async function deleteWorkspace() {
    if (deleteWorkspaceBusy) return
    setDeleteWorkspaceBusy(true)
    setError('')
    try {
      const result = await gitApi.deleteTaskWorkspace(projectId, taskId)
      setWorkspace(result)
      setSelected('')
      setShowAdd(false)
      setDeleteWorkspaceOpen(false)
      await scan()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setDeleteWorkspaceOpen(false)
    } finally { setDeleteWorkspaceBusy(false) }
  }

  return <section className="git-page task-git-page" aria-label={t('git.taskWorkspace')}>
    <header className="git-page-header">
      <h1>{t('git.taskWorkspace')}</h1>
      <small title={workspace?.path}>{workspace?.path}</small>
      <span className="git-grow" />
      {available.length > 0 && <Button size="sm" onClick={() => setShowAdd(value => !value)}>{t('git.taskAddRepository')}</Button>}
      <Button className="task-git-delete-workspace" size="sm" variant="danger" disabled={loading} onClick={() => setDeleteWorkspaceOpen(true)}>{t('git.taskDeleteWorkspace')}</Button>
      <Button size="sm" loading={loading} onClick={() => void refresh()}>{t('git.refresh')}</Button>
    </header>
    {error && <div className="git-error" role="alert">{error}</div>}
    {loading ? <div className="git-empty"><Icon name="loader-circle" className="git-spin" size={24} />{t('git.loading')}</div> : <>
      {showAdd && available.length > 0 && <div className="task-git-add">
        <label>{t('git.taskAddRepository')}
          <select value={repositoryId} onChange={event => {
            const id = event.target.value
            const repo = available.find(item => item.id === id)
            const suffix = (taskId.replace(/[^A-Za-z0-9]/g, '') || 'task').slice(0, 8)
            const stem = repo?.name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[._-]+|[._-]+$/g, '')
              || `repo-${repo?.id.slice(0, 6) || 'git'}`
            const nextAlias = repo ? `${stem.slice(0, 63 - suffix.length)}-${suffix}` : ''
            setRepositoryId(id)
            setAlias(nextAlias)
            setSyncEmptyDirectory(false)
            setBranchName(nextAlias)
          }}>
            <option value="">{t('git.taskSelectRepository')}</option>
            {available.map(repo => <option key={repo.id} value={repo.id}>{repo.projects.find(item => item.id === projectId)?.relative_path === '.' ? t('git.taskProjectRoot') : repo.projects.find(item => item.id === projectId)?.relative_path || repo.name}</option>)}
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
      {workspace?.worktrees.length ? <div className="git-page-body">
        <aside className="task-git-tree" style={{ width: treeWidth, flexBasis: treeWidth }}>
          {workspace.worktrees.map(tree => <div className="task-git-tree-row" key={tree.id}>
            <button type="button" className={tree.id === selectedTree?.id ? 'selected' : ''} onClick={() => setSelected(tree.id)} title={tree.path}>
              <Icon name="git-fork" size={16} /><span><strong>{tree.alias}</strong><small>{tree.branch}</small></span>
            </button>
            <button type="button" className="task-git-remove" title={t('git.taskRemove')} aria-label={`${t('git.taskRemove')} ${tree.alias}`} onClick={() => setRemoving(tree.alias)}><Icon name="trash" size={14} /></button>
          </div>)}
        </aside>
        <div className="git-tree-resizer" role="separator" aria-orientation="vertical" aria-label={t('git.resizeTree')} aria-valuemin={230} aria-valuemax={clampGitTreeWidth(Number.MAX_SAFE_INTEGER)} aria-valuenow={treeWidth} tabIndex={0} onPointerDown={startResize} onDoubleClick={resetResize} onKeyDown={resizeWithKeyboard} />
        {selectedTree && <GitWorktreePanel key={selectedTree.id} id={selectedTree.id} onLocate={id => {
          if (workspace.worktrees.some(tree => tree.id === id)) setSelected(id)
        }} onChanged={refresh} />}
      </div> : <div className="git-empty"><Icon name="git-fork" size={28} /><h2>{t('git.taskEmpty')}</h2><p>{t('git.taskEmptyHint')}</p></div>}
    </>}
    <ConfirmDialog open={!!removing} title={t('git.taskRemove')} message={t('git.taskRemoveHint', { name: removing })} confirmText={t('git.taskRemove')} danger loading={removeBusy} onConfirm={() => void remove()} onCancel={() => { if (!removeBusy) setRemoving('') }} />
    <ConfirmDialog open={deleteWorkspaceOpen} title={t('git.taskDeleteWorkspace')} message={t('git.taskDeleteWorkspaceHint', { count: workspace?.worktrees.length ?? 0 })} confirmText={t('git.taskDeleteWorkspace')} danger loading={deleteWorkspaceBusy} onConfirm={() => void deleteWorkspace()} onCancel={() => { if (!deleteWorkspaceBusy) setDeleteWorkspaceOpen(false) }} />
  </section>
}
