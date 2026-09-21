import { useState } from 'react'
import { gitApi, type GitStatus } from '../../api/git'
import { useGitStore } from '../../stores/gitStore'
import { useI18n } from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'

export default function GitRemoteActions({ status, readOnly, onRefresh, onBusy }: { status: GitStatus; readOnly: boolean; onRefresh: () => Promise<void>; onBusy: (busy: boolean) => void }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState<'pull' | 'push' | null>(null)
  const [notice, setNotice] = useState('')
  const blocked = readOnly ? t('git.remoteReadOnly') : status.files.length ? t('git.remoteDirty') : status.operation ? t('git.blocked') : status.active ? t('git.remoteRunning') : !status.branch || !status.upstream ? t('git.remoteNoUpstream') : ''
  async function run(action: 'pull' | 'push') {
    if (busy || blocked || !status.branch) return
    setBusy(action); onBusy(true); setNotice('')
    try {
      await gitApi[action](status.id, status.branch, status.snapshot)
      setNotice(t('git.remoteSuccess', { action: action === 'push' ? 'Push' : 'Pull' }))
    } catch (e) { setNotice(t('git.remoteFailure', { action: action === 'push' ? 'Push' : 'Pull', error: e instanceof Error ? e.message : String(e) })) }
    finally {
      useGitStore.getState().referencesChanged()
      try { await onRefresh() } finally { setBusy(null); onBusy(false) }
    }
  }
  return <span className="git-remote-actions">
    <Button size="sm" title={blocked || t('git.pullHint')} disabled={!!blocked || !!busy} loading={busy === 'pull'} onClick={() => void run('pull')}>{busy === 'pull' ? t('git.pulling') : t('git.pullButton')}</Button>
    <Button size="sm" title={status.files.length ? t('git.pushDirty') : blocked || t('git.pushButton')} disabled={!!blocked || !!busy} loading={busy === 'push'} onClick={() => void run('push')}>{busy === 'push' ? t('git.pushing') : t('git.pushButton')}</Button>
    {notice && <span className="git-remote-notice" role="status"><span>{notice}</span><Button variant="icon" aria-label={t('git.close')} onClick={() => setNotice('')}><Icon name="x" size={13} /></Button></span>}
  </span>
}
