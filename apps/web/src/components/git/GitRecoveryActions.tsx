import { useEffect, useState } from 'react'
import { type GitMergeOperation, type GitRecoveryPreview, type GitRecoveryRequest, type GitStatus } from '../../api/git'
import { useI18n } from '../../i18n'
import { useGitStore } from '../../stores/gitStore'
import Button from '../Button'
import ConfirmDialog from '../ConfirmDialog'
import Icon from '../Icon'
import { useGitApi } from './GitApiContext'

export default function GitRecoveryActions({ status, disabled, request, onCloseRequest, onRefresh }: {
  status: GitStatus
  disabled: boolean
  request: GitRecoveryRequest | null
  onCloseRequest: () => void
  onRefresh: () => Promise<void>
}) {
  const gitApi = useGitApi()
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [merges, setMerges] = useState<GitMergeOperation[]>([])
  const [preview, setPreview] = useState<GitRecoveryPreview | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pushTarget, setPushTarget] = useState<{ branch: string; head: string } | null>(null)

  useEffect(() => {
    if (!request) return
    setOpen(true); setPreview(null); setError(''); setNotice(''); setPushTarget(null); setBusy(true)
    gitApi.recoveryPreview(status.id, request).then(setPreview).catch(reason => {
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => setBusy(false))
  }, [gitApi, status.id, request])

  async function show() {
    setOpen(true); setPreview(null); setError(''); setNotice(''); setPushTarget(null); setBusy(true)
    try {
      const result = await gitApi.recoveries(status.id)
      setMerges(result.merges.filter(item => !item.undone_by))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }

  async function select(body: GitRecoveryRequest) {
    setPreview(null); setError(''); setBusy(true)
    try { setPreview(await gitApi.recoveryPreview(status.id, body)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }

  async function apply() {
    if (!preview || busy) return
    setBusy(true); setError('')
    try {
      const result = await gitApi.recoveryApply(status.id, { ...preview.request, expected_head: preview.head })
      setNotice(t('git.recoverySuccess'))
      setPushTarget(result.push_available ? { branch: result.target, head: result.head } : null)
      setOpen(false); setPreview(null); onCloseRequest()
      useGitStore.getState().referencesChanged()
      await onRefresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }

  function close() {
    if (busy) return
    setOpen(false); setPreview(null); setError(''); onCloseRequest()
  }

  async function pushRecoveredTarget() {
    if (!pushTarget || busy) return
    setBusy(true)
    try {
      await gitApi.pushBranch(status.id, pushTarget.branch, pushTarget.head)
      setNotice(t('git.mergePushSuccess', { branch: pushTarget.branch }))
      setPushTarget(null)
      await onRefresh()
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }

  return <>
    <Button size="sm" disabled={disabled || !status.branch || !status.head} onClick={() => void show()}>{t('git.recoveryButton')}</Button>
    {notice && <span role="status" className="git-remote-toast git-remote-toast--success">{notice}{pushTarget && <Button size="sm" loading={busy} onClick={() => void pushRecoveredTarget()}>{t('git.mergePushTarget', { branch: pushTarget.branch })}</Button>}<Button variant="icon" aria-label={t('git.close')} onClick={() => { setNotice(''); setPushTarget(null) }}><Icon name="x" size={13} /></Button></span>}
    <ConfirmDialog open={open} title={t('git.recoveryTitle')} message={preview ? t('git.recoveryPreviewHint', { branch: preview.request.target, head: preview.head.slice(0, 8) }) : t('git.recoveryChooseHint')} confirmText={t('git.recoveryApply')} loading={busy} confirmDisabled={!preview || busy} onConfirm={() => void apply()} onCancel={close} width={600}>
      {busy && <p><Icon name="loader-circle" className="git-spin" size={14} />{t('git.loading')}</p>}
      {error && <p className="git-error" role="alert">{error}</p>}
      {!preview && !request && <div className="git-recovery-list">
        {merges.length ? merges.map(item => <Button key={item.id} size="sm" onClick={() => void select({ mode: 'undo_merge', target: item.target, operation_id: item.id })}>{t('git.recoveryUndoMerge')} · {item.source} → {item.target} · {item.after.slice(0, 8)}</Button>) : !busy && <p>{t('git.recoveryNoMerges')}</p>}
      </div>}
      {preview && <div className="git-recovery-files"><strong>{t('git.recoveryFiles', { count: preview.files.length })}</strong><ul>{preview.changes.map(change => <li key={change.path}>{change.path} <small>+{change.added} −{change.deleted}</small></li>)}</ul></div>}
    </ConfirmDialog>
  </>
}
