import { useEffect, useState } from 'react'
import { type GitBranch } from '../../api/git'
import { useI18n } from '../../i18n'
import { useGitApi } from './GitApiContext'
import Button from '../Button'
import Icon from '../Icon'

export default function GitBranchPushPanel({ id, branch, onClose, onBusy, onPushed }: {
  id: string
  branch: GitBranch
  onClose: () => void
  onBusy: (busy: boolean) => void
  onPushed: (branch: string) => Promise<void>
}) {
  const gitApi = useGitApi()
  const { t } = useI18n()
  const [remotes, setRemotes] = useState<string[]>([])
  const [remote, setRemote] = useState('')
  const [target, setTarget] = useState(branch.name)
  const [setUpstream, setSetUpstream] = useState(!branch.upstream)
  const [loading, setLoading] = useState(true)
  const [pushing, setPushing] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let current = true
    onBusy(true)
    gitApi.remotes(id).then(inventory => {
      if (!current) return
      const names = inventory.remotes.map(item => item.name)
      const preferred = branch.remote && branch.remote !== '.' && names.includes(branch.remote)
        ? branch.remote : names[0] || ''
      setRemotes(names); setRemote(preferred)
      setTarget(branch.upstream && preferred && branch.upstream.startsWith(preferred + '/')
        ? branch.upstream.slice(preferred.length + 1) : branch.name)
    }).catch(reason => { if (current) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (current) { setLoading(false); onBusy(false) } })
    return () => { current = false; onBusy(false) }
  }, [gitApi, id, branch.name, branch.remote, branch.upstream, onBusy])

  async function push() {
    if (!remote || !target.trim() || loading || pushing) return
    setPushing(true); onBusy(true); setError('')
    try {
      await gitApi.pushBranch(id, branch.name, branch.head, {
        remote, targetBranch: target.trim(), setUpstream,
      })
      await onPushed(branch.name)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setPushing(false); onBusy(false) }
  }

  return <div className="git-branch-push" role="dialog" aria-label={t('git.branchPushTitle', { branch: branch.name })}>
    <strong>{t('git.branchPushTitle', { branch: branch.name })}</strong><Button variant="icon" aria-label={t('git.close')} onClick={onClose}><Icon name="x" size={14} /></Button>
    <label>{t('git.remoteSource')}<select value={remote} disabled={loading || pushing} onChange={event => setRemote(event.target.value)}><option value="">{t('git.selectRemote')}</option>{remotes.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
    <label>{t('git.targetBranch')}<input name="pushTargetBranch" value={target} disabled={loading || pushing} onChange={event => setTarget(event.target.value)} /></label>
    <label className="git-branch-push-track"><input type="checkbox" checked={setUpstream} disabled={loading || pushing} onChange={event => setSetUpstream(event.target.checked)} />{t('git.setUpstream')}</label>
    <Button size="sm" variant="primary" loading={loading || pushing} disabled={!remote || !target.trim()} onClick={() => void push()}>{t('git.pushConfirm')}</Button>
    {error && <span role="alert" className="git-danger">{error}</span>}
  </div>
}
