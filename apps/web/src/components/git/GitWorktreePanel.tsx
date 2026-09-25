import { useGitApi, useReadOnlyGit } from './GitApiContext'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type GitStatus, type GitFile, type GitCommit, type GitRecoveryRequest, type Comparison } from '../../api/git'
import { useI18n } from '../../i18n'
import Icon from '../Icon'
import Button from '../Button'
import GitChanges, { GitFileList } from './GitChanges'
import GitBranchPicker from './GitBranchPicker'
import GitHistory from './GitHistory'
import GitDiffDialog from './GitDiffDialog'
import GitRemoteActions from './GitRemoteActions'
import GitMergeActions, { type GitMergeRequest } from './GitMergeActions'
import GitRecoveryActions from './GitRecoveryActions'
import { createPanelGitWrites, PanelGitWritesContext } from './gitPanelWrites'

function HistoricalChanges({ id, comparison, onFiles }: { id: string; comparison: Comparison; onFiles: (files: GitFile[], path: string) => void }) {
  const gitApi = useGitApi()
  const { t } = useI18n()
  const [files, setFiles] = useState<GitFile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    setLoading(true); setError('')
    gitApi.changes(id, { ref: comparison.ref, commit: comparison.commit }).then(r => { if (current) setFiles(r.files) }).catch(e => { if (current) setError(e.message) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [gitApi, id, comparison.ref, comparison.commit])
  return loading ? <div className="git-empty"><Icon name="loader-circle" className="git-spin" size={20} />{t('git.loading')}</div> : error ? <p className="git-error" role="alert">{error}</p> : <GitFileList files={files} onDiff={path => onFiles(files, path)} />
}

export default function GitWorktreePanel({ id, branch, displayPath, onLocate, onChanged }: { id: string; branch?: string; displayPath?: string; onLocate: (id: string) => void; onChanged: () => Promise<void> }) {
  const gitApi = useGitApi()
  const readOnly = useReadOnlyGit()
  const { t } = useI18n()
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'changes' | 'history'>(branch ? 'history' : 'changes')
  const [picker, setPicker] = useState(false)
  const [mergeRequest, setMergeRequest] = useState<GitMergeRequest | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const [commit, setCommit] = useState<GitCommit>()
  const [recoveryRequest, setRecoveryRequest] = useState<GitRecoveryRequest | null>(null)
  const [diff, setDiff] = useState<{ files: string[]; path: string; comparison: Comparison } | null>(null)
  const pending = useRef<Promise<void> | null>(null)
  const mounted = useRef(true)
  const refresh = useCallback(() => {
    if (pending.current) return pending.current
    setLoading(true)
    pending.current = gitApi.status(id).then(s => { if (mounted.current) { setStatus(s); setError('') } }).catch(e => { if (mounted.current) setError(e.message) }).finally(() => { pending.current = null; if (mounted.current) setLoading(false) })
    return pending.current
  }, [gitApi, id])
  const [writes] = useState(createPanelGitWrites)
  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, 8000)
    const focus = () => { if (!document.hidden) void refresh() }
    document.addEventListener('visibilitychange', focus)
    return () => { mounted.current = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', focus) }
  }, [refresh])
  useEffect(() => {
    if (!picker) return
    const close = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPicker(false)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setPicker(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [picker])
  const comparison = { ref: branch, commit: commit?.hash }
  const historical = !!branch || !!commit
  const open = (files: GitFile[], path: string) => setDiff({ files: files.map(f => f.path), path, comparison })
  return <PanelGitWritesContext.Provider value={writes}><main className="git-workspace">
    <div className="git-context"><div><h2><Icon name="git-fork" size={19} />{branch || status?.branch || t('git.detached')}{(historical || readOnly) && <small>{t('git.readOnly')}</small>}</h2><p title={displayPath || status?.path}>{displayPath || status?.path}</p></div><Button size="sm" loading={loading} onClick={() => void refresh()}><Icon name="refresh" size={14} />{t('git.refresh')}</Button>{status && <GitRemoteActions status={status} readOnly={historical || readOnly} onRefresh={refresh} onBusy={busy => { if (busy) setPicker(false) }} />}{status && <GitMergeActions status={status} readOnly={historical || readOnly} request={mergeRequest} onRefresh={refresh} onBusy={busy => { if (busy) setPicker(false) }} />}{status && !readOnly && <GitRecoveryActions status={status} disabled={status.active || !!status.operation || !status.branch} request={recoveryRequest} onCloseRequest={() => setRecoveryRequest(null)} onRefresh={async () => { await refresh(); await onChanged() }} />}{status && !readOnly && <div className="git-branch-popover" ref={pickerRef}><Button size="sm" aria-expanded={picker} aria-haspopup="listbox" onClick={() => setPicker(!picker)}>{t('git.switch')}<Icon name="chevron-down" size={13} /></Button>{picker && <GitBranchPicker onRefresh={refresh} status={status} onLocate={onLocate} onMerge={historical ? undefined : (direction, selectedBranch) => { setPicker(false); setMergeRequest({ direction, branch: selectedBranch }) }} onChanged={async () => { setPicker(false); await refresh(); await onChanged(); onLocate(id) }} />}</div>}</div>
    {error && <div className="git-error" role="alert">{error}<Button size="sm" onClick={() => void refresh()}>{t('git.retry')}</Button></div>}
    <div className="git-tabs"><button className={tab === 'changes' ? 'selected' : ''} onClick={() => { setTab('changes'); setCommit(undefined) }}>{branch ? t('git.compare') : t('git.changes')}{!branch && <small>{status?.files.length || 0}</small>}</button><button className={tab === 'history' ? 'selected' : ''} onClick={() => { setTab('history'); setCommit(undefined) }}>{t('git.history')}</button><span>{status?.upstream ? `${status.upstream} ↑${status.ahead ?? '—'} ↓${status.behind ?? '—'}` : t('git.updated')}</span></div>
    {commit && <div className="git-selection-bar"><code>{commit.hash.slice(0, 8)}</code>{!readOnly && !branch && status?.branch && <><Button size="sm" onClick={() => setRecoveryRequest({ mode: 'restore_tree', target: status.branch!, commit: commit.hash })}>{t('git.recoveryRestoreAt')}</Button>{commit.parents.length === 2 && <Button size="sm" onClick={() => setRecoveryRequest({ mode: 'undo_commit', target: status.branch!, commit: commit.hash })}>{t('git.recoveryUndoMerge')}</Button>}</>}<Button size="sm" onClick={() => setCommit(undefined)}>{t('git.history')}</Button></div>}
    <div className="git-workspace-content">{commit ? <HistoricalChanges id={id} comparison={comparison} onFiles={open} /> : tab === 'history' ? <GitHistory id={id} branch={branch} head={status?.head} onCommit={setCommit} /> : branch ? <HistoricalChanges id={id} comparison={comparison} onFiles={open} /> : status ? <GitChanges status={status} onRefresh={refresh} onDiff={path => open(status.files, path)} /> : loading && <div className="git-empty"><Icon name="loader-circle" className="git-spin" size={22} />{t('git.loading')}</div>}</div>
    {diff && <GitDiffDialog id={id} files={diff.files} path={diff.path} comparison={diff.comparison} onSelect={path => setDiff({ ...diff, path })} onSaved={refresh} onClose={() => setDiff(null)} />}
  </main></PanelGitWritesContext.Provider>
}
