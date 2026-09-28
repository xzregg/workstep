import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import ConfirmDialog from './ConfirmDialog'
import './DeleteTaskConfirmation.css'

interface Props {
  open: boolean
  count: number
  busy?: boolean
  onConfirm: (deleteWorkspace: boolean) => void
  onCancel: () => void
}

export default function DeleteTaskConfirmation({ open, count, busy = false, onConfirm, onCancel }: Props) {
  const { t } = useI18n()
  const [deleteWorkspace, setDeleteWorkspace] = useState(true)
  useEffect(() => { if (open) setDeleteWorkspace(true) }, [open])

  return <ConfirmDialog
    open={open}
    title={t(count > 1 ? 'taskList.bulkDeleteTitle' : 'taskList.deleteTask')}
    message={count > 1 ? t('taskList.bulkDeleteMessage', { count }) : t('taskList.deleteTaskMessage')}
    confirmText={t(count > 1 ? 'taskList.bulkDelete' : 'common.delete')}
    danger
    loading={busy}
    onConfirm={() => onConfirm(deleteWorkspace)}
    onCancel={() => { if (!busy) onCancel() }}
  >
    <label className="delete-task-workspace-choice">
      <input type="checkbox" checked={deleteWorkspace} onChange={event => setDeleteWorkspace(event.target.checked)} />
      <span>{t('taskList.deleteWorkspaceWithTask')}</span>
    </label>
    {!deleteWorkspace && <p className="delete-task-workspace-hint">{t('taskList.keepTaskWorkspaceHint')}</p>}
  </ConfirmDialog>
}
