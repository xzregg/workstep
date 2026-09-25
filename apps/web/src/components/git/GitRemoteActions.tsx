import { useGitApi } from './GitApiContext'
import { useEffect, useRef, useState } from 'react'
import { type GitRemotes, type GitStatus } from '../../api/git'
import { useGitStore } from '../../stores/gitStore'
import { useI18n } from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'
import { usePanelGitWrites } from './gitPanelWrites'

export default function GitRemoteActions({ status, readOnly, onRefresh, onBusy }: { status: GitStatus; readOnly: boolean; onRefresh: () => Promise<void>; onBusy: (busy: boolean) => void }) {
  const gitApi = useGitApi()
  const writes = usePanelGitWrites()
  const { t } = useI18n()
  const root = useRef<HTMLSpanElement>(null)
  const [mode, setMode] = useState<'pull' | 'push' | null>(null)
  const [busy, setBusy] = useState<'pull' | 'push' | null>(null)
  const [loading, setLoading] = useState(false)
  const [inventory, setInventory] = useState<GitRemotes | null>(null)
  const [remote, setRemote] = useState('')
  const [targetBranch, setTargetBranch] = useState('')
  const [setUpstream, setSetUpstream] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; title: string; detail: string } | null>(null)
  const blocked = readOnly ? t('git.remoteReadOnly') : status.operation ? t('git.blocked') : status.active ? t('git.remoteRunning') : !status.branch || !status.head ? t('git.remoteNoCommit') : ''

  useEffect(() => {
    if (!mode) return
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setMode(null) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMode(null) }
    document.addEventListener('mousedown', close); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [mode])

  function applyInventory(value: GitRemotes, action: 'pull' | 'push', preferredRemote?: string) {
    setInventory(value)
    const selectedRemote = preferredRemote && value.remotes.some(item => item.name === preferredRemote)
      ? preferredRemote : value.upstream?.remote || value.remotes[0]?.name || ''
    const selected = value.remotes.find(item => item.name === selectedRemote)
    const suggested = action === 'push' ? status.branch || ''
      : value.upstream?.remote === selectedRemote ? value.upstream.branch
      : selected?.branches.find(item => item.name === status.branch)?.name || selected?.branches[0]?.name || ''
    setRemote(selectedRemote); setTargetBranch(suggested || ''); setSetUpstream(!value.upstream)
  }

  async function open(action: 'pull' | 'push') {
    if (blocked || busy) return
    setMode(action); setLoading(true); setError(''); setNotice(null)
    try { applyInventory(await gitApi.remotes(status.id), action) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }

  function selectRemote(value: string) {
    setRemote(value)
    if (mode === 'pull') {
      const branches = inventory?.remotes.find(item => item.name === value)?.branches || []
      setTargetBranch(branches.find(item => item.name === status.branch)?.name || branches[0]?.name || '')
    }
  }

  async function refreshRemote() {
    if (!remote || loading || writes.busy) return
    setLoading(true); setError('')
    try {
      await writes.run(async () => {
        try { applyInventory(await gitApi.fetchRemote(status.id, remote), mode || 'pull', remote) }
        finally { useGitStore.getState().referencesChanged(); await onRefresh() }
      })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }

  async function run(action: 'pull' | 'push') {
    if (busy || writes.busy || blocked || !status.branch || !remote || !targetBranch.trim()) return
    const target = targetBranch.trim()
    setBusy(action); onBusy(true); setError(''); setNotice(null)
    try {
      await writes.run(async () => {
        try {
          await gitApi[action](status.id, status.branch!, status.snapshot, { remote, targetBranch: target, setUpstream })
          setNotice({ kind: 'success', title: action === 'push' ? t('git.pushSuccess') : t('git.pullSuccess'), detail: action === 'push' ? `${status.branch} → ${remote}/${target}` : `${remote}/${target} → ${status.branch}` })
          setMode(null)
        } finally { useGitStore.getState().referencesChanged(); await onRefresh() }
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message); setNotice({ kind: 'error', title: action === 'push' ? t('git.pushFailure') : t('git.pullFailure'), detail: message })
    }
    finally { setBusy(null); onBusy(false) }
  }
  const selected = inventory?.remotes.find(item => item.name === remote)
  const route = mode === 'push' ? `${status.branch} → ${remote || '—'}/${targetBranch || '—'}` : `${remote || '—'}/${targetBranch || '—'} → ${status.branch}`
  return <span className="git-remote-actions" ref={root}>
    <Button size="sm" title={blocked || t('git.pullHint')} disabled={!!blocked || !!busy || writes.busy} loading={busy === 'pull'} aria-expanded={mode === 'pull'} onClick={() => void open('pull')}>{busy === 'pull' ? t('git.pulling') : t('git.pullButton')}<Icon name="chevron-down" size={12} /></Button>
    <Button size="sm" title={blocked || t('git.pushButton')} disabled={!!blocked || !!busy || writes.busy} loading={busy === 'push'} aria-expanded={mode === 'push'} onClick={() => void open('push')}>{busy === 'push' ? t('git.pushing') : t('git.pushButton')}<Icon name="chevron-down" size={12} /></Button>
    {mode && <span className="git-remote-panel" role="dialog" aria-label={mode === 'push' ? t('git.pushTitle') : t('git.pullTitle')}>
      <span className="git-remote-panel__heading"><span><strong>{mode === 'push' ? t('git.pushTitle') : t('git.pullTitle')}</strong><small>{mode === 'push' ? t('git.pushDescription') : t('git.pullDescription')}</small></span><Button variant="icon" aria-label={t('git.close')} onClick={() => setMode(null)}><Icon name="x" size={14} /></Button></span>
      {loading && !inventory ? <span className="git-remote-loading"><Icon name="loader-circle" className="git-spin" size={14} />{t('git.remoteLoading')}</span> : <>
        <label>{t('git.remoteSource')}<select value={remote} onChange={event => selectRemote(event.target.value)}><option value="">{t('git.selectRemote')}</option>{inventory?.remotes.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
        {selected?.push_url && <small className="git-remote-url" title={mode === 'push' ? selected.push_url : selected.url}>{mode === 'push' ? selected.push_url : selected.url}</small>}
        <label>{mode === 'push' ? t('git.targetBranch') : t('git.remoteBranch')}
          {mode === 'pull' ? <select name="targetBranch" value={targetBranch} onChange={event => setTargetBranch(event.target.value)}><option value="">{t('git.selectBranch')}</option>{selected?.branches.map(branch => <option key={branch.name} value={branch.name}>{branch.name}</option>)}</select>
            : <><input name="targetBranch" list="git-remote-branches" value={targetBranch} onChange={event => setTargetBranch(event.target.value)} placeholder={status.branch || ''} /><datalist id="git-remote-branches">{selected?.branches.map(branch => <option key={branch.name} value={branch.name} />)}</datalist></>}
        </label>
        <span className="git-remote-route"><small>{t('git.syncRoute')}</small><strong>{route}</strong>{inventory?.upstream && <small>{t('git.currentUpstream', { upstream: `${inventory.upstream.remote}/${inventory.upstream.branch}` })}</small>}</span>
        <label className="git-remote-track"><input type="checkbox" checked={setUpstream} onChange={event => setSetUpstream(event.target.checked)} /> <span>{t('git.setUpstream')}<small>{t('git.setUpstreamHint')}</small></span></label>
        {error && <span className="git-remote-error" role="alert">{error}</span>}
        <span className="git-remote-panel__actions"><Button size="sm" loading={loading} disabled={!remote || !!busy || writes.busy} onClick={() => void refreshRemote()}><Icon name="refresh" size={13} />{t('git.fetchRemote')}</Button><Button size="sm" variant="primary" loading={!!busy} disabled={!remote || !targetBranch.trim() || !!loading || writes.busy} onClick={() => void run(mode)}>{mode === 'push' ? t('git.pushConfirm') : t('git.pullConfirm')}</Button></span>
      </>}
    </span>}
    {notice && <span className={`git-remote-toast git-remote-toast--${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}><span className="git-remote-toast__icon"><Icon name={notice.kind === 'success' ? 'check' : 'x'} size={14} /></span><span><strong>{notice.title}</strong><small>{notice.detail}</small></span><Button variant="icon" aria-label={t('git.close')} onClick={() => setNotice(null)}><Icon name="x" size={13} /></Button></span>}
  </span>
}
