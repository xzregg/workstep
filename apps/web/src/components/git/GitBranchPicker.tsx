import { isProtectedGitBranch } from './branchProtection'
import { useGitApi, useGitActionAllowed } from './GitApiContext'
import { useCallback, useEffect, useState } from 'react'
import { type GitBranch, type GitStatus, type GitTrackedRemoteBranch } from '../../api/git'
import { useI18n } from '../../i18n'
import Button from '../Button'
import { useGitStore } from '../../stores/gitStore'
import Icon from '../Icon'
import GitBranchStatus, { branchMatchScore } from './GitBranchStatus'
import GitBranchPushPanel from './GitBranchPushPanel'
import ConfirmDialog from '../ConfirmDialog'
import type { GitMergeRequest } from './GitMergeActions'
import { usePanelGitWrites } from './gitPanelWrites'

function rankMatches<T>(items: T[], query: string, getScore: (item: T) => number | null) {
  if (!query.trim()) return items
  return items
    .map((item, index) => ({ item, index, score: getScore(item) }))
    .filter((entry): entry is { item: T; index: number; score: number } => entry.score != null)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(entry => entry.item)
}

export default function GitBranchPicker({ status, onLocate, onChanged, onRefresh, onMerge }: { status: GitStatus; onLocate: (id: string) => void; onChanged: () => Promise<void>; onRefresh?: () => Promise<void>; onMerge?: (direction: GitMergeRequest['direction'], branch: string) => void }) {
  const gitApi = useGitApi()
  const can = useGitActionAllowed()
  const writes = usePanelGitWrites()
  const { t } = useI18n()
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [remoteBranches, setRemoteBranches] = useState<GitTrackedRemoteBranch[]>([])
  const [showRemote, setShowRemote] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'fetch' | 'pull' | 'switch' | 'update' | 'create' | 'push' | 'delete' | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [baseRef, setBaseRef] = useState(`local\0${status.branch || ''}`)
  const [pushBranch, setPushBranch] = useState<GitBranch | null>(null)
  const [deleteBranch, setDeleteBranch] = useState<GitBranch | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [notice, setNotice] = useState('')
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  useEffect(() => {
    let current = true
    setLoading(true); setRemoteBranches([]); setShowRemote(false)
    gitApi.branches(status.id).then(r => { if (current) { setBranches(r.branches); setBaseRef(value => r.branches.some(branch => value === `local\0${branch.name}`) ? value : `local\0${status.branch || r.branches[0]?.name || ''}`); setFetchedAt(r.fetched_at || null) } }).catch(e => { if (current) setError(e.message) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [status.id, status.branch])
  const blocked = status.active ? t('git.running') : status.operation ? t('git.blocked') : ''
  const dirtyNote = status.files.length ? t('git.switchDirty') : ''
  const invalidName = !newName || /\s/.test(newName)
  const [baseKind, baseName, remoteBranch] = baseRef.split('\0')
  const baseAvailable = baseKind === 'remote'
    ? remoteBranches.some(item => item.remote === baseName && item.branch === remoteBranch)
    : branches.some(item => item.name === baseName)
  const onPushBusy = useCallback((value: boolean) => setBusy(value ? 'push' : null), [])
  async function onPushed(branch: string) {
    const result = await gitApi.branches(status.id)
    setBranches(result.branches); setRemoteBranches(result.remote_branches || [])
    setPushBranch(null); setNotice(t('git.branchPushSuccess', { branch }))
    useGitStore.getState().referencesChanged()
    await onRefresh?.()
  }
  async function deleteSelectedBranch() {
    if (!deleteBranch || busy || writes.busy) return
    setBusy('delete'); setDeleteError('')
    try {
      await writes.run(async () => {
        try {
          const result = await gitApi.deleteBranch(status.id, deleteBranch.name, deleteBranch.head, status.snapshot)
          setBranches(result.branches); setRemoteBranches(result.remote_branches || [])
          setDeleteBranch(null); setNotice(t('git.deleteBranchSuccess', { branch: deleteBranch.name }))
          useGitStore.getState().referencesChanged()
          await onRefresh?.()
        } catch (reason) { setDeleteError(reason instanceof Error ? reason.message : String(reason)) }
      })
    } catch (reason) { setDeleteError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(null) }
  }
  async function createBranch() {
    if (busy || writes.busy || blocked || invalidName || !baseAvailable) return
    const [kind, first, second] = baseRef.split('\0')
    const base = kind === 'remote'
      ? remoteBranches.find(item => item.remote === first && item.branch === second)
      : branches.find(item => item.name === first)
    if (!base) { setError(t('git.createBranchBaseMissing')); return }
    setBusy('create'); setError('')
    try {
      await writes.run(async () => {
        try {
          const result = await gitApi.createBranch(status.id, newName, kind === 'remote' ? second : first, base.head, status.snapshot, kind === 'remote' ? first : undefined)
          setBranches(result.branches); setRemoteBranches(result.remote_branches || [])
          setCreateOpen(false); setNewName(''); setQuery('')
          useGitStore.getState().referencesChanged()
          await onRefresh?.()
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); await onRefresh?.() }
      })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }
  async function run(action: 'fetch' | 'pull' | 'switch' | 'update', branch?: string, remote?: string) {
    if (busy || writes.busy) return
    setBusy(action); setError('')
    try {
      await writes.run(async () => {
        try {
          if (action === 'fetch') {
            const result = await gitApi.fetch(status.id)
            setBranches(result.branches); setRemoteBranches(result.remote_branches || []); setShowRemote(true); setFetchedAt(result.fetched_at || null)
            useGitStore.getState().referencesChanged()
            await onRefresh?.()
          } else if (action === 'pull') {
            await gitApi.pull(status.id, branch!, status.snapshot)
            await onChanged()
          } else if (action === 'update') {
            if (branch === status.branch) {
              await gitApi.pull(status.id, branch, status.snapshot)
              await onChanged()
            } else {
              const result = await gitApi.advance(status.id, branch!, status.snapshot)
              setBranches(result.branches); setFetchedAt(result.fetched_at || null)
              useGitStore.getState().referencesChanged()
              await onRefresh?.()
            }
          } else { await gitApi.switch(status.id, branch!, status.snapshot, remote); await onChanged() }
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); await onRefresh?.() }
      })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }
  const filtered = rankMatches(branches, query, branch => branchMatchScore(branch.name, `${branch.upstream || ''} ${branch.path || ''}`, query))
  const filteredRemote = showRemote ? rankMatches(remoteBranches, query, branch => branchMatchScore(branch.branch, `${branch.name} ${branch.remote}`, query)) : []
  return <div className={`git-branch-picker${createOpen || pushBranch ? ' git-branch-picker--creating' : ''}`}>
    <div className="git-branch-tools"><label className="git-search"><Icon name="search" size={14} /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder={t('git.branchSearch')} aria-label={t('git.branchSearch')} /></label><Button size="sm" disabled={!!busy || loading} loading={busy === 'fetch'} onClick={() => void run('fetch')}>{busy === 'fetch' ? t('git.fetching') : t('git.fetchBranches')}</Button><Button size="sm" disabled={!!busy || loading || !!blocked} onClick={() => setCreateOpen(!createOpen)}>{t('git.newBranch')}</Button></div>
    {createOpen && <div className="git-branch-create"><label>{t('git.newBranchName')}<input name="newBranch" value={newName} onChange={event => setNewName(event.target.value)} placeholder="feature/example" /></label><label>{t('git.newBranchBase')}<select name="baseBranch" value={baseRef} onChange={event => setBaseRef(event.target.value)}><optgroup label={t('git.localBranches')}>{branches.map(branch => <option key={branch.name} value={`local\0${branch.name}`}>{branch.name}</option>)}</optgroup>{showRemote && <optgroup label={t('git.remoteBranches')}>{remoteBranches.map(branch => <option key={branch.name} value={`remote\0${branch.remote}\0${branch.branch}`}>{branch.name}</option>)}</optgroup>}</select></label><Button size="sm" variant="primary" loading={busy === 'create'} disabled={!!busy || invalidName || !baseAvailable} onClick={() => void createBranch()}>{t('git.createBranch')}</Button><small>{t('git.createBranchHint')}</small></div>}
    {pushBranch && <GitBranchPushPanel id={status.id} branch={pushBranch} onClose={() => setPushBranch(null)} onBusy={onPushBusy} onPushed={onPushed} />}
    <div className="git-branch-meta">
      <p className="git-sync-note">{showRemote ? t('git.remoteBranchesLoaded', { count: remoteBranches.length, time: fetchedAt ? new Date(fetchedAt * 1000).toLocaleString() : '—' }) : t('git.localBranchesOnly')}</p>
      {blocked && <p>{blocked}</p>}{dirtyNote && <p>{dirtyNote}</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert" className="git-danger">{error}</p>}
    </div>
    <div className="git-branch-list" role="listbox" aria-label={t('git.branches')}>
      {loading ? <p><Icon name="loader-circle" className="git-spin" size={14} /> {t('git.loading')}</p> : !filtered.length && !filteredRemote.length ? <p>{t('git.noBranches')}</p> : <><div className="git-branch-section">{t('git.localBranches')}</div>{filtered.map(b => <div className="git-branch-row" role="option" aria-selected={b.name === status.branch} key={b.name}>
        <span className="git-branch-name">{b.name}<small>{b.upstream || b.path}</small></span><GitBranchStatus branch={b} />
        <div className="git-branch-actions">
        {can('advance') && !!b.behind && !b.ahead && !b.upstream_gone && !(b.worktree_id && b.worktree_id !== status.id) && <Button variant="icon" className="git-branch-update" aria-label={t('git.pullBranchUpdates', { branch: b.name, count: b.behind })} title={t('git.pullBranchUpdates', { branch: b.name, count: b.behind })} disabled={!!busy || !!blocked} loading={busy === 'update'} onClick={() => void run('update', b.name)}><Icon name="download" size={13} /></Button>}
        {can('pushBranch') && <Button size="sm" className="git-branch-push-button" disabled={!!busy || !!blocked} onClick={() => { setPushBranch(b); setNotice(''); setCreateOpen(false) }}>{t('git.pushButton')}</Button>}
        <Button variant="icon" className="git-branch-delete" aria-label={t('git.deleteBranchTitle', { branch: b.name })} title={b.worktree_id ? t('git.deleteBranchOccupied') : t('git.deleteBranchTitle', { branch: b.name })} disabled={!!busy || !!blocked || !!b.worktree_id || isProtectedGitBranch(b.name)} onClick={() => { setDeleteBranch(b); setDeleteError('') }}><Icon name="trash" size={13} /></Button>
        {onMerge && <span className="git-branch-merge">{b.name !== status.branch && <><Button size="sm" disabled={!!busy || !!blocked || !status.head} onClick={() => onMerge('intoCurrent', b.name)}>{t('git.mergeToCurrentButton')}</Button><Button size="sm" disabled={!!busy || !!blocked || !status.head} onClick={() => onMerge('intoTarget', b.name)}>{t('git.mergeToBranchButton')}</Button></>}</span>}
        <span className="git-branch-final">{b.name === status.branch ? <small>{t('git.current')}</small> : b.worktree_id && b.worktree_id !== status.id ? <Button size="sm" disabled={!!busy} onClick={() => onLocate(b.worktree_id!)}>{t('git.locate')}</Button> : <Button size="sm" loading={busy === 'switch'} disabled={!!busy || !!blocked} onClick={() => void run('switch', b.name)}>{t('git.switch')}</Button>}</span>
        </div>
      </div>)}{showRemote && <div className="git-branch-section">{t('git.remoteBranches')}</div>}{filteredRemote.map(branch => <div className="git-branch-row git-branch-row--remote" role="option" aria-selected={false} key={branch.name}><span className="git-branch-name">{branch.name}<small>{t('git.remoteBranch')}</small></span><Button size="sm" loading={busy === 'switch'} disabled={!!busy || !!blocked} onClick={() => void run('switch', branch.branch, branch.remote)}>{t('git.switch')}</Button></div>)}</>}
    </div>
    <ConfirmDialog open={!!deleteBranch} title={t('git.deleteBranchTitle', { branch: deleteBranch?.name || '' })} message={t('git.deleteBranchHint', { branch: deleteBranch?.name || '' })} confirmText={t('git.deleteBranchConfirm')} danger loading={busy === 'delete'} onConfirm={() => void deleteSelectedBranch()} onCancel={() => { if (busy !== 'delete') { setDeleteBranch(null); setDeleteError('') } }}>{deleteError && <p role="alert" className="git-danger">{deleteError}</p>}</ConfirmDialog>
  </div>
}
