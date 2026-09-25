import { useEffect, useRef, useState } from 'react'
import { type GitBranch, type GitStatus, type GitTrackedRemoteBranch } from '../../api/git'
import { useI18n } from '../../i18n'
import { useGitApi } from './GitApiContext'
import { useGitStore } from '../../stores/gitStore'
import Button from '../Button'
import Icon from '../Icon'
import { usePanelGitWrites } from './gitPanelWrites'

export type GitMergeRequest = { direction: 'intoCurrent' | 'intoTarget'; branch: string }

export default function GitMergeActions({ status, readOnly, otherBusy = false, request, onRefresh, onBusy }: { status: GitStatus; readOnly: boolean; otherBusy?: boolean; request?: GitMergeRequest | null; onRefresh: () => Promise<void>; onBusy: (busy: boolean) => void }) {
  const gitApi = useGitApi()
  const writes = usePanelGitWrites()
  const { t } = useI18n()
  const root = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [remoteBranches, setRemoteBranches] = useState<GitTrackedRemoteBranch[]>([])
  const [direction, setDirection] = useState<'intoCurrent' | 'intoTarget'>('intoCurrent')
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [noticeError, setNoticeError] = useState(false)
  const [pushTarget, setPushTarget] = useState<{ branch: string; head: string } | null>(null)
  const blockedReason = otherBusy || writes.busy ? t('git.networkBusy') : readOnly ? t('git.remoteReadOnly')
    : status.active ? t('git.remoteRunning') : status.operation ? t('git.blocked')
    : !status.branch || !status.head ? t('git.remoteNoCommit') : ''

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [open])

  useEffect(() => {
    if (request) void show(request)
  }, [request])

  async function show(selection?: GitMergeRequest) {
    if (selection) {
      setDirection(selection.direction)
      setSource(selection.direction === 'intoCurrent' ? `local\0\0${selection.branch}` : '')
      setTarget(selection.direction === 'intoTarget' ? selection.branch : '')
    }
    setOpen(true); setLoading(true); setError(''); setNotice(''); setPushTarget(null)
    try {
      const result = await gitApi.branches(status.id)
      setBranches(result.branches); setRemoteBranches(result.remote_branches || [])
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }

  async function fetchBranches() {
    if (loading || busy || writes.busy) return
    setLoading(true); setError('')
    try {
      const result = await writes.run(async () => {
        try { return await gitApi.fetch(status.id) }
        finally { useGitStore.getState().referencesChanged(); await onRefresh() }
      })
      setBranches(result.branches); setRemoteBranches(result.remote_branches || [])
      setSource('')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }

  async function run() {
    if (!status.branch || busy || blockedReason || (direction === 'intoCurrent' ? !source : !target)) return
    setBusy(true); onBusy(true); setError(''); setNotice(''); setNoticeError(false); setPushTarget(null)
    try {
      await writes.run(async () => {
        try {
          if (direction === 'intoCurrent') {
            const [kind, remote, branch] = source.split('\0')
            await gitApi.merge(status.id, status.branch!, status.snapshot, branch, kind === 'remote' ? remote : undefined)
            setNotice(t('git.mergeSuccess'))
          } else {
            const result = await gitApi.mergeInto(status.id, status.branch!, status.snapshot, target)
            setNotice(t('git.mergeIntoSuccess', { branch: result.target }))
            if (result.push_available) setPushTarget({ branch: result.target, head: result.head })
          }
          setOpen(false)
        } finally { useGitStore.getState().referencesChanged(); await onRefresh() }
      })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false); onBusy(false) }
  }

  async function pushMergedTarget() {
    if (!pushTarget || busy || writes.busy) return
    setBusy(true); onBusy(true)
    try {
      await writes.run(async () => {
        try {
          await gitApi.pushBranch(status.id, pushTarget.branch, pushTarget.head)
          setNotice(t('git.mergePushSuccess', { branch: pushTarget.branch }))
          setNoticeError(false); setPushTarget(null)
        } finally { useGitStore.getState().referencesChanged(); await onRefresh() }
      })
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
      setNoticeError(true)
    } finally { setBusy(false); onBusy(false) }
  }

  return <span className="git-remote-actions" ref={root}>
    <Button size="sm" disabled={busy || otherBusy || writes.busy} title={blockedReason || t('git.mergeTitle')} loading={busy} aria-expanded={open} onClick={() => void show()}>{t('git.mergeButton')}<Icon name="chevron-down" size={12} /></Button>
    {open && <span className="git-remote-panel" role="dialog" aria-label={t('git.mergeTitle')}>
      <span className="git-remote-panel__heading"><span><strong>{t('git.mergeTitle')}</strong><small>{direction === 'intoCurrent' ? t('git.mergeHint', { branch: status.branch || '' }) : t('git.mergeIntoHint', { branch: status.branch || '' })}</small></span><Button variant="icon" aria-label={t('git.close')} onClick={() => setOpen(false)}><Icon name="x" size={14} /></Button></span>
      <label>{t('git.mergeDirection')}<select value={direction} onChange={event => setDirection(event.target.value as 'intoCurrent' | 'intoTarget')} disabled={busy}>
        <option value="intoCurrent">{t('git.mergeIntoCurrent')}</option><option value="intoTarget">{t('git.mergeIntoTarget')}</option>
      </select></label>
      {direction === 'intoCurrent' ? <label>{t('git.mergeSource')}<select value={source} onChange={event => setSource(event.target.value)} disabled={loading || busy}>
        <option value="">{t('git.mergeSource')}</option>
        <optgroup label={t('git.localBranches')}>{branches.filter(item => item.name !== status.branch).map(item => <option key={item.name} value={`local\0\0${item.name}`}>{item.name}</option>)}</optgroup>
        <optgroup label={t('git.remoteBranches')}>{remoteBranches.map(item => <option key={item.name} value={`remote\0${item.remote}\0${item.branch}`}>{item.name}</option>)}</optgroup>
      </select></label> : <label>{t('git.targetBranch')}<select value={target} onChange={event => setTarget(event.target.value)} disabled={loading || busy}>
        <option value="">{t('git.targetBranch')}</option>{branches.filter(item => item.name !== status.branch).map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
      </select></label>}
      {loading && <span className="git-remote-loading"><Icon name="loader-circle" className="git-spin" size={14} />{t('git.loading')}</span>}
      {!!status.files.length && <span className="git-remote-loading">{direction === 'intoCurrent' ? t('git.mergeDirtyHint') : t('git.mergeSourceDirtyHint')}</span>}
      {blockedReason && <span className="git-remote-error" role="status">{blockedReason}</span>}
      {error && <span className="git-remote-error" role="alert">{error}</span>}
      <span className="git-remote-panel__actions"><Button size="sm" loading={loading} disabled={loading || busy || writes.busy} onClick={() => void fetchBranches()}><Icon name="refresh" size={13} />{t('git.fetchBranches')}</Button><Button size="sm" variant="primary" loading={busy} disabled={!(direction === 'intoCurrent' ? source : target) || loading || busy || !!blockedReason} onClick={() => void run()}>{t('git.mergeConfirm')}</Button></span>
    </span>}
    {notice && <span className={`git-remote-toast git-remote-toast--${noticeError ? 'error' : 'success'}`} role={noticeError ? 'alert' : 'status'}><span><strong>{notice}</strong></span>{pushTarget && <Button size="sm" loading={busy} disabled={busy || writes.busy} onClick={() => void pushMergedTarget()}>{t('git.mergePushTarget', { branch: pushTarget.branch })}</Button>}<Button variant="icon" aria-label={t('git.close')} onClick={() => { setNotice(''); setPushTarget(null) }}><Icon name="x" size={13} /></Button></span>}
  </span>
}
