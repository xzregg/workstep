import { useI18n } from '../i18n'
import ConfirmDialog from './ConfirmDialog'

interface Props {
  open: boolean
  count: number
  busy?: boolean
  onConfirm: (deleteWorkspace: boolean) => void
  onCancel: () => void
}

export default function DeleteTaskConfirmation({ open, count, busy = false, onConfirm, onCancel }: Props) {
  const { t } = useI18n()

  return <ConfirmDialog
    open={open}
    title={t(count > 1 ? 'taskList.bulkDeleteTitle' : 'taskList.deleteTask')}
    message={count > 1 ? t('taskList.bulkDeleteMessage', { count }) : t('taskList.deleteTaskMessage')}
    confirmText={t(count > 1 ? 'taskList.bulkDelete' : 'common.delete')}
    danger
    loading={busy}
    onConfirm={() => onConfirm(true)}
    onCancel={() => { if (!busy) onCancel() }}
  />
}
