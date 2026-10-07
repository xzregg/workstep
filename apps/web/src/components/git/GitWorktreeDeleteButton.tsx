import { useState } from 'react'
import { gitApi, type GitWorktree } from '../../api/git'
import { useI18n } from '../../i18n'
import { useGitStore } from '../../stores/gitStore'
import Button from '../Button'
import Icon from '../Icon'
import ConfirmDialog from '../ConfirmDialog'

export default function GitWorktreeDeleteButton({ tree, onDeleted }: { tree: GitWorktree; onDeleted: () => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const name = tree.branch || t('git.detached')
  async function remove() {
    if (busy) return
    setBusy(true); setError('')
    try {
      if (!tree.available || tree.prunable) {
        await gitApi.deleteWorktree(tree.id, undefined, tree.head)
      } else {
        const state = await gitApi.status(tree.id)
        await gitApi.deleteWorktree(tree.id, state.snapshot)
      }
      setOpen(false)
      onDeleted()
      useGitStore.getState().referencesChanged()
      await useGitStore.getState().scan()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <><Button variant="icon" className="git-tree-delete" aria-label={t('git.deleteWorktreeTitle', { name })} title={t('git.deleteWorktreeTitle', { name })} onClick={() => { setError(''); setOpen(true) }}><Icon name="trash" size={13} /></Button>
    <ConfirmDialog open={open} title={t('git.deleteWorktreeTitle', { name })} message={t('git.deleteWorktreeHint', { name, path: tree.path })} confirmText={t('common.delete')} danger loading={busy} onConfirm={() => void remove()} onCancel={() => { if (!busy) setOpen(false) }}>{error && <p role="alert" className="git-danger">{error}</p>}</ConfirmDialog></>
}
