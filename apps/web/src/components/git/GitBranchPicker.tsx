import { useGitApi } from './GitApiContext'
import { useEffect, useState } from 'react'
import { type GitBranch, type GitStatus, type GitTrackedRemoteBranch } from '../../api/git'
import { useI18n } from '../../i18n'
import Button from '../Button'
import { useGitStore } from '../../stores/gitStore'
import Icon from '../Icon'
import GitBranchStatus, { branchMatchScore } from './GitBranchStatus'

function rankMatches<T>(items: T[], query: string, getScore: (item: T) => number | null) {
  if (!query.trim()) return items
  return items
    .map((item, index) => ({ item, index, score: getScore(item) }))
    .filter((entry): entry is { item: T; index: number; score: number } => entry.score != null)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(entry => entry.item)
}

export default function GitBranchPicker({ status, onLocate, onChanged, onRefresh }: { status: GitStatus; onLocate: (id: string) => void; onChanged: () => Promise<void>; onRefresh?: () => Promise<void> }) {
  const gitApi = useGitApi()
  const { t } = useI18n()
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [remoteBranches, setRemoteBranches] = useState<GitTrackedRemoteBranch[]>([])
  const [showRemote, setShowRemote] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'fetch' | 'pull' | 'switch' | 'update' | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  useEffect(() => {
    let current = true
    setLoading(true); setRemoteBranches([]); setShowRemote(false)
    gitApi.branches(status.id).then(r => { if (current) { setBranches(r.branches); setFetchedAt(r.fetched_at || null) } }).catch(e => { if (current) setError(e.message) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [status.id, status.branch])
  const blocked = status.active ? t('git.running') : status.operation ? t('git.blocked') : ''
  const dirtyNote = status.files.length ? t('git.switchDirty') : ''
  async function run(action: 'fetch' | 'pull' | 'switch' | 'update', branch?: string, remote?: string) {
    if (busy) return
    setBusy(action); setError('')
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
    finally { setBusy(null) }
  }
  const filtered = rankMatches(branches, query, branch => branchMatchScore(branch.name, `${branch.upstream || ''} ${branch.path || ''}`, query))
  const filteredRemote = showRemote ? rankMatches(remoteBranches, query, branch => branchMatchScore(branch.branch, `${branch.name} ${branch.remote}`, query)) : []
  return <div className="git-branch-picker">
    <div className="git-branch-tools"><label className="git-search"><Icon name="search" size={14} /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder={t('git.branchSearch')} aria-label={t('git.branchSearch')} /></label><Button size="sm" disabled={!!busy || loading} loading={busy === 'fetch'} onClick={() => void run('fetch')}>{busy === 'fetch' ? t('git.fetching') : t('git.fetchBranches')}</Button></div>
    <div className="git-branch-meta">
      <p className="git-sync-note">{showRemote ? t('git.remoteBranchesLoaded', { count: remoteBranches.length, time: fetchedAt ? new Date(fetchedAt * 1000).toLocaleString() : '—' }) : t('git.localBranchesOnly')}</p>
      {blocked && <p>{blocked}</p>}{dirtyNote && <p>{dirtyNote}</p>}{error && <p role="alert" className="git-danger">{error}</p>}
    </div>
    <div className="git-branch-list" role="listbox" aria-label={t('git.branches')}>
      {loading ? <p><Icon name="loader-circle" className="git-spin" size={14} /> {t('git.loading')}</p> : !filtered.length && !filteredRemote.length ? <p>{t('git.noBranches')}</p> : <><div className="git-branch-section">{t('git.localBranches')}</div>{filtered.map(b => <div className="git-branch-row" role="option" aria-selected={b.name === status.branch} key={b.name}>
        <span className="git-branch-name">{b.name}<small>{b.upstream || b.path}</small></span><GitBranchStatus branch={b} />
        {!!b.behind && !b.ahead && !b.upstream_gone && !(b.worktree_id && b.worktree_id !== status.id) && <Button variant="icon" className="git-branch-update" aria-label={t('git.pullBranchUpdates', { branch: b.name, count: b.behind })} title={t('git.pullBranchUpdates', { branch: b.name, count: b.behind })} disabled={!!busy || !!blocked} loading={busy === 'update'} onClick={() => void run('update', b.name)}><Icon name="download" size={13} /></Button>}
        {b.name === status.branch ? <small>{t('git.current')}</small> : b.worktree_id && b.worktree_id !== status.id ? <Button size="sm" disabled={!!busy} onClick={() => onLocate(b.worktree_id!)}>{t('git.locate')}</Button> : <Button size="sm" loading={busy === 'switch'} disabled={!!busy || !!blocked} onClick={() => void run('switch', b.name)}>{t('git.switch')}</Button>}
      </div>)}{showRemote && <div className="git-branch-section">{t('git.remoteBranches')}</div>}{filteredRemote.map(branch => <div className="git-branch-row git-branch-row--remote" role="option" aria-selected={false} key={branch.name}><span className="git-branch-name">{branch.name}<small>{t('git.remoteBranch')}</small></span><Button size="sm" loading={busy === 'switch'} disabled={!!busy || !!blocked} onClick={() => void run('switch', branch.branch, branch.remote)}>{t('git.switch')}</Button></div>)}</>}
    </div>
  </div>
}
