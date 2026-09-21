import { useEffect, useState } from 'react'
import { gitApi, type GitBranch, type GitStatus } from '../../api/git'
import { useI18n } from '../../i18n'
import Button from '../Button'
import { useGitStore } from '../../stores/gitStore'
import Icon from '../Icon'
import GitBranchStatus, { matchesBranch } from './GitBranchStatus'

export default function GitBranchPicker({ status, onLocate, onChanged, onRefresh }: { status: GitStatus; onLocate: (id: string) => void; onChanged: () => Promise<void>; onRefresh?: () => Promise<void> }) {
  const { t } = useI18n()
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'fetch' | 'pull' | 'switch' | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  useEffect(() => {
    let current = true
    setLoading(true)
    gitApi.branches(status.id).then(r => { if (current) { setBranches(r.branches); setFetchedAt(r.fetched_at || null) } }).catch(e => { if (current) setError(e.message) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [status.id, status.branch])
  const blocked = status.active ? t('git.running') : status.operation ? t('git.blocked') : status.files.length ? t('git.dirty') : ''
  async function run(action: 'fetch' | 'pull' | 'switch', branch?: string) {
    if (busy) return
    setBusy(action); setError('')
    try {
      if (action === 'fetch') {
        const result = await gitApi.fetch(status.id)
        setBranches(result.branches); setFetchedAt(result.fetched_at || null)
        useGitStore.getState().referencesChanged()
        await onRefresh?.()
      } else if (action === 'pull') {
        await gitApi.pull(status.id, branch!, status.snapshot)
        await onChanged()
      } else { await gitApi.switch(status.id, branch!, status.snapshot); await onChanged() }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); await onRefresh?.() }
    finally { setBusy(null) }
  }
  const filtered = branches.filter(b => matchesBranch(b, query))
  return <div className="git-branch-picker">
    <div className="git-branch-tools"><label className="git-search"><Icon name="search" size={14} /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder={t('git.branchSearch')} aria-label={t('git.branchSearch')} /></label><Button size="sm" disabled={!!busy || loading} loading={busy === 'fetch'} onClick={() => void run('fetch')}>{busy === 'fetch' ? t('git.fetching') : t('git.fetch')}</Button></div>
    <div className="git-branch-meta">
      <p className="git-sync-note">{fetchedAt ? t('git.lastFetch', { time: new Date(fetchedAt * 1000).toLocaleString() }) : t('git.syncCached')}</p>
      {blocked && <p>{blocked}</p>}{error && <p role="alert" className="git-danger">{error}</p>}
    </div>
    <div className="git-branch-list" role="listbox" aria-label={t('git.branches')}>
      {loading ? <p><Icon name="loader-circle" className="git-spin" size={14} /> {t('git.loading')}</p> : !filtered.length ? <p>{t('git.noBranches')}</p> : filtered.map(b => <div className="git-branch-row" role="option" aria-selected={b.name === status.branch} key={b.name}>
        <span className="git-branch-name">{b.name}<small>{b.upstream || b.path}</small></span><GitBranchStatus branch={b} />
        {b.name === status.branch ? <><small>{t('git.current')}</small><Button size="sm" title={blocked || t('git.pullHint')} disabled={!!busy || !!blocked || !b.upstream || b.upstream_gone} loading={busy === 'pull'} onClick={() => void run('pull', b.name)}>{busy === 'pull' ? t('git.pulling') : t('git.pull')}</Button></> : b.worktree_id && b.worktree_id !== status.id ? <Button size="sm" disabled={!!busy} onClick={() => onLocate(b.worktree_id!)}>{t('git.locate')}</Button> : <Button size="sm" loading={busy === 'switch'} disabled={!!busy || !!blocked} onClick={() => void run('switch', b.name)}>{t('git.switch')}</Button>}
      </div>)}
    </div>
  </div>
}
